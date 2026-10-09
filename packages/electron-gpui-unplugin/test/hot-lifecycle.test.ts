import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HotSession } from "../src/hot.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawn: vi.fn() }));

let directory: string;
let source: string;
let manifest: string;
let addon: string;
let session: HotSession;
let compiling: EventEmitter;
const original = "struct Counter { count: i64 }\nfn value() -> usize { 1 }\n";

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "electron-gpui-hot-lifecycle-"));
  const crate = path.join(directory, "native");
  const sdk = path.join(directory, "sdk/electron-gpui");
  const tool = path.join(directory, "sdk/electron-gpui-hotpatch");
  mkdirSync(path.join(crate, "src"), { recursive: true });
  mkdirSync(sdk, { recursive: true });
  mkdirSync(tool, { recursive: true });
  manifest = path.join(crate, "Cargo.toml");
  source = path.join(crate, "src/lib.rs");
  writeFileSync(manifest, "[package]\nname = 'views'\n");
  writeFileSync(source, original);
  addon = path.join(crate, "index.node");
  writeFileSync(addon, "fixture addon");
  writeFileSync(path.join(tool, "Cargo.toml"), "tool");
  vi.mocked(execFileSync).mockReturnValue(
    JSON.stringify({
      target_directory: path.join(directory, "target"),
      workspace_root: directory,
      packages: [
        { name: "views", manifest_path: manifest, targets: [{ name: "views", kind: ["cdylib"] }] },
        { name: "electron-gpui", manifest_path: path.join(sdk, "Cargo.toml"), targets: [] },
      ],
    }),
  );
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  session = new HotSession({
    projectDir: directory,
    crateDir: crate,
    build: true,
    release: false,
    universal: false,
    assetFileName: "views.node",
    builtAddon: addon,
  });
  await session.fatBuild();
  writeFileSync(path.join(session.dir, "app.json"), JSON.stringify({ pid: process.pid, anchor: "0x123" }));
  compiling = new EventEmitter();
  vi.mocked(spawn)
    .mockClear()
    .mockImplementation(() => compiling as ReturnType<typeof spawn>);
  session.start();
});

afterEach(async () => {
  session.stop();
  compiling.emit("exit", 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function waitForCompile(): Promise<void> {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { timeout: 5000 });
}

it("discards a compiled patch and queued edits after stopping", async () => {
  writeFileSync(source, original.replace("{ 1 }", "{ 2 }"));
  await waitForCompile();
  writeFileSync(source, original.replace("{ 1 }", "{ 3 }"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  writeFileSync(path.join(session.dir, "pending.json.tmp"), '{"map":{},"aslr_reference":0}');
  session.stop();
  compiling.emit("exit", 0);
  await vi.waitFor(() => expect(existsSync(path.join(session.dir, "pending.json.tmp"))).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(existsSync(path.join(session.dir, "patch-1.json"))).toBe(false);
  expect(readFileSync(session.triggerFile, "utf8")).toBe("");
});

it("cancels acknowledgement polling immediately without restarting", async () => {
  writeFileSync(source, original.replace("{ 1 }", "{ 2 }"));
  await waitForCompile();
  writeFileSync(path.join(session.dir, "pending.json.tmp"), '{"map":{},"aslr_reference":0}');
  compiling.emit("exit", 0);
  const patch = path.join(session.dir, "patch-1.json");
  await vi.waitFor(() => expect(existsSync(patch)).toBe(true));
  session.stop();
  await vi.waitFor(() => expect(existsSync(patch)).toBe(false), { timeout: 1000 });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(readFileSync(session.triggerFile, "utf8")).toBe("");
});

it("does not trigger an Electron restart when a stopped full build finishes", async () => {
  writeFileSync(manifest, "manifest changed");
  await waitForCompile();
  expect(vi.mocked(spawn).mock.calls[0]?.[1]?.[0]).toBe("fat");
  session.stop();
  compiling.emit("exit", 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(readFileSync(session.triggerFile, "utf8")).toBe("");
  expect(spawn).toHaveBeenCalledTimes(1);
});

it.each(["fingerprinted", "legacy"])(
  "waits for a %s client to load the rebuilt addon before patching",
  async (client) => {
    const buildId = () => createHash("sha256").update(readFileSync(addon)).digest("hex");
    const register = (anchor: string): void =>
      writeFileSync(
        path.join(session.dir, "app.json"),
        JSON.stringify({
          pid: process.pid,
          anchor,
          ...(client === "fingerprinted" ? { buildId: buildId() } : {}),
        }),
      );
    register("0x123");
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      if (args?.[0] === "fat") writeFileSync(addon, "rebuilt addon");
      else writeFileSync(path.join(session.dir, "pending.json.tmp"), '{"map":{},"aslr_reference":0}');
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    await session.fatBuild();
    vi.mocked(spawn).mockClear();
    writeFileSync(source, original.replace("{ 1 }", "{ 2 }"));
    await vi.waitFor(() => expect(readFileSync(session.triggerFile, "utf8")).not.toBe(""), { timeout: 5000 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.[0]).toBe("fat");
    expect(existsSync(path.join(session.dir, "patch-1.json"))).toBe(false);
    register("0x456");
    vi.mocked(spawn).mockClear();
    writeFileSync(source, original.replace("{ 1 }", "{ 3 }"));
    await vi.waitFor(() => expect(existsSync(path.join(session.dir, "patch-1.json"))).toBe(true), {
      timeout: 5000,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.[0]).toBe("patch");
    writeFileSync(path.join(session.dir, "result-1.json"), '{"ok":true}');
  },
);
