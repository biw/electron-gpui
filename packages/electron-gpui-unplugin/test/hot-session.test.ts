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
      workspace_root: directory,
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

it.each(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "new .cargo/config.toml"])(
  "rebuilds a member crate after its parent workspace's %s changes",
  async (configuration) => {
    const directory = mkdtempSync(path.join(tmpdir(), "electron-gpui-workspace-session-"));
    const crate = path.join(directory, "member");
    const sdk = path.join(directory, "sdk/electron-gpui");
    const tool = path.join(directory, "sdk/electron-gpui-hotpatch");
    const created = configuration.startsWith("new ");
    const file = path.join(directory, configuration.replace(/^new /, ""));
    mkdirSync(path.join(crate, "src"), { recursive: true });
    mkdirSync(sdk, { recursive: true });
    mkdirSync(tool, { recursive: true });
    if (!created) mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(path.join(crate, "Cargo.toml"), "[package]\nname = 'views'\n");
    writeFileSync(path.join(crate, "src/lib.rs"), "fn value() { 1 }\n");
    writeFileSync(path.join(tool, "Cargo.toml"), "[package]\nname = 'electron-gpui-hotpatch'\n");
    if (!created) writeFileSync(file, "original");
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        target_directory: path.join(directory, "target"),
        workspace_root: directory,
        packages: [
          {
            name: "views",
            manifest_path: path.join(crate, "Cargo.toml"),
            targets: [{ name: "views", kind: ["cdylib"] }],
          },
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
      session.start();
      vi.mocked(spawn).mockClear();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "changed");
      await vi.waitFor(() => expect(readFileSync(session.triggerFile, "utf8")).not.toBe(""), {
        timeout: 5000,
      });
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spawn).mock.calls[0]?.[1]?.[0]).toBe("fat");
    } finally {
      session.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("watches a path dependency added while the session is running", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "electron-gpui-added-dependency-"));
  const crate = path.join(directory, "member");
  const dependency = path.join(directory, "new-dependency");
  const sdk = path.join(directory, "sdk/electron-gpui");
  const tool = path.join(directory, "sdk/electron-gpui-hotpatch");
  for (const dir of [crate, dependency, sdk, tool]) mkdirSync(path.join(dir, "src"), { recursive: true });
  const manifest = path.join(crate, "Cargo.toml");
  writeFileSync(manifest, "original");
  writeFileSync(path.join(crate, "src/lib.rs"), "fn value() { 1 }\n");
  writeFileSync(path.join(tool, "Cargo.toml"), "tool");
  const dependencySource = path.join(dependency, "src/lib.rs");
  writeFileSync(dependencySource, "pub const VALUE: usize = 1;\n");
  let added = false;
  vi.mocked(execFileSync).mockImplementation(() =>
    JSON.stringify({
      target_directory: path.join(directory, "target"),
      workspace_root: directory,
      packages: [
        {
          id: "views",
          name: "views",
          source: null,
          manifest_path: manifest,
          targets: [{ name: "views", kind: ["cdylib"] }],
        },
        {
          id: "sdk",
          name: "electron-gpui",
          source: null,
          manifest_path: path.join(sdk, "Cargo.toml"),
          targets: [],
        },
        {
          id: "new",
          name: "new-dependency",
          source: null,
          manifest_path: path.join(dependency, "Cargo.toml"),
          targets: [],
        },
      ],
      resolve: { nodes: [{ id: "views", deps: added ? [{ pkg: "new" }] : [] }] },
    }),
  );
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
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
    session.start();
    added = true;
    writeFileSync(manifest, "added path dependency");
    await vi.waitFor(() => expect(readFileSync(session.triggerFile, "utf8")).not.toBe(""), { timeout: 5000 });
    writeFileSync(session.triggerFile, "");
    vi.mocked(spawn).mockClear();
    writeFileSync(dependencySource, "pub const VALUE: usize = 2;\n");
    await vi.waitFor(() => expect(readFileSync(session.triggerFile, "utf8")).not.toBe(""), { timeout: 5000 });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.[0]).toBe("fat");
    session.stop();
    vi.mocked(spawn).mockClear();
    writeFileSync(manifest, "edited after stop");
    writeFileSync(dependencySource, "pub const VALUE: usize = 3;\n");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  } finally {
    session.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
