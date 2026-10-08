import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type HotAddon, hotConfigOf, startHotClient } from "../src/hot.js";

let dir: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "electron-gpui-hot-"));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function waitForFile(file: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) return readFileSync(file, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${file} never appeared`);
}

function fakeAddon(apply: (json: string) => void = () => {}): HotAddon & { applied: string[] } {
  const applied: string[] = [];
  return {
    applied,
    hotAnchor: () => "0x1234",
    applyHotPatch: (json) => {
      apply(json);
      applied.push(json);
    },
  };
}

describe("hotConfigOf", () => {
  it("reads the config the bundler plugin attaches", () => {
    const addon = {};
    expect(hotConfigOf(addon)).toBeUndefined();
    Object.defineProperty(addon, "__electronGpuiHot", { value: { dir: "/tmp/x" } });
    expect(hotConfigOf(addon)).toEqual({ dir: "/tmp/x" });
  });
});

describe("startHotClient", () => {
  it("registers the app, applies patches and reports success", async () => {
    const addon = fakeAddon();
    stop = startHotClient(addon, { dir });
    expect(JSON.parse(readFileSync(join(dir, "app.json"), "utf8"))).toEqual({
      pid: process.pid,
      anchor: "0x1234",
    });

    writeFileSync(join(dir, "patch-1.json"), '{"map":{}}');
    const result = JSON.parse(await waitForFile(join(dir, "result-1.json")));
    expect(result.ok).toBe(true);
    expect(addon.applied).toEqual(['{"map":{}}']);
    expect(existsSync(join(dir, "patch-1.json"))).toBe(false);
  });

  it("applies the table of a patch built for this process, removing the file first", async () => {
    const file = join(dir, "patch-2.json");
    const addon = fakeAddon(() => expect(existsSync(file)).toBe(false));
    stop = startHotClient(addon, { dir });
    writeFileSync(
      file,
      JSON.stringify({ target: { pid: process.pid, anchor: "0x1234" }, table: { map: {} } }),
    );
    expect(JSON.parse(await waitForFile(join(dir, "result-2.json"))).ok).toBe(true);
    expect(addon.applied).toEqual(['{"map":{}}']);
  });

  it("refuses patches built for another process", async () => {
    const addon = fakeAddon();
    stop = startHotClient(addon, { dir });
    writeFileSync(
      join(dir, "patch-3.json"),
      JSON.stringify({ target: { pid: 1, anchor: "0x1234" }, table: {} }),
    );
    const result = JSON.parse(await waitForFile(join(dir, "result-3.json")));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("built for app process 1");
    expect(addon.applied).toEqual([]);
    expect(existsSync(join(dir, "patch-3.json"))).toBe(false);
  });

  it("drops patches left by an earlier session instead of applying them", async () => {
    writeFileSync(join(dir, "patch-4.json"), '{"map":{}}');
    const addon = fakeAddon();
    stop = startHotClient(addon, { dir });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(addon.applied).toEqual([]);
    expect(existsSync(join(dir, "patch-4.json"))).toBe(false);
    expect(existsSync(join(dir, "result-4.json"))).toBe(false);
  });

  it("reports patches the addon rejects", async () => {
    stop = startHotClient(
      fakeAddon(() => {
        throw new Error("bad table");
      }),
      { dir },
    );
    writeFileSync(join(dir, "patch-7.json"), "{}");
    expect(JSON.parse(await waitForFile(join(dir, "result-7.json")))).toEqual({
      ok: false,
      error: "bad table",
    });
  });

  it("ignores unrelated files and removes its registration when stopped", async () => {
    const addon = fakeAddon();
    const onApplied = vi.fn();
    stop = startHotClient(addon, { dir }, onApplied);
    writeFileSync(join(dir, "notes.json"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(addon.applied).toEqual([]);
    expect(onApplied).not.toHaveBeenCalled();

    stop();
    stop = undefined;
    expect(existsSync(join(dir, "app.json"))).toBe(false);
  });
});
