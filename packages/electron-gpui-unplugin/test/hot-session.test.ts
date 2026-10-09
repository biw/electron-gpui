import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { HotSession } from "../src/hot.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawn: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("processes an edit saved while the previous patch is being acknowledged", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "electron-gpui-hot-session-"));
  const crate = path.join(directory, "native");
  const sdk = path.join(directory, "sdk/electron-gpui");
  const tool = path.join(directory, "sdk/electron-gpui-hotpatch");
  mkdirSync(path.join(crate, "src"), { recursive: true });
  mkdirSync(sdk, { recursive: true });
  mkdirSync(tool, { recursive: true });
  const manifest = path.join(crate, "Cargo.toml");
  const source = path.join(crate, "src/lib.rs");
  writeFileSync(manifest, "[package]\nname = 'views'\n");
  writeFileSync(path.join(tool, "Cargo.toml"), "[package]\nname = 'electron-gpui-hotpatch'\n");
  const original = "struct Counter { count: i64 }\nfn value() -> usize { 1 }\n";
  writeFileSync(source, original);
  vi.mocked(execFileSync).mockReturnValue(
    JSON.stringify({
      target_directory: path.join(directory, "target"),
      packages: [
        { name: "views", manifest_path: manifest, targets: [{ name: "views", kind: ["cdylib"] }] },
        { name: "electron-gpui", manifest_path: path.join(sdk, "Cargo.toml"), targets: [] },
      ],
    }),
  );
  const child = (code: number) => {
    const process = new EventEmitter() as ReturnType<typeof spawn>;
    queueMicrotask(() => process.emit("exit", code));
    return process;
  };
  vi.mocked(spawn).mockImplementation(() => child(0));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const session = new HotSession({
    projectDir: directory,
    crateDir: crate,
    build: true,
    release: false,
    universal: false,
    assetFileName: "views.node",
    builtAddon: path.join(crate, "index.node"),
  });
  try {
    await session.fatBuild();
    writeFileSync(path.join(session.dir, "app.json"), JSON.stringify({ pid: process.pid, anchor: "0x123" }));
    const compiled: string[] = [];
    vi.mocked(spawn).mockImplementation(() => {
      compiled.push(readFileSync(source, "utf8"));
      if (compiled.length === 1) {
        writeFileSync(path.join(session.dir, "pending.json.tmp"), '{"map":{},"aslr_reference":0}');
        return child(0);
      }
      return child(10); // The later save has a compile error.
    });
    session.start();
    const patched = original.replace("{ 1 }", "{ 2 }");
    writeFileSync(source, patched);
    await vi.waitFor(() => expect(existsSync(path.join(session.dir, "patch-1.json"))).toBe(true), {
      timeout: 5000,
    });
    const later = `${patched}compile_error!("saved during acknowledgement");\n`;
    writeFileSync(source, later);
    writeFileSync(path.join(session.dir, "result-1.json"), '{"ok":true}');
    await vi.waitFor(() => expect(compiled.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(compiled[0]).toBe(patched);
    expect(compiled[1]).toBe(later);
  } finally {
    session.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
