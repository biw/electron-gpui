import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  ADDON_PATH_PLACEHOLDER,
  addonModuleCode,
  assetFileName,
  developmentAsset,
  ensureBuild,
  invalidateBuild,
  isCrateInput,
  localDependencies,
  resolveAddonPath,
  resolveOptions,
} from "../src/core.js";

describe("resolveOptions", () => {
  it("defaults to ./native and electron-gpui.node", () => {
    const options = resolveOptions({ cwd: "/app" });
    expect(options.crateDir).toBe(path.resolve("/app/native"));
    expect(options.builtAddon).toBe(path.resolve("/app/native/index.node"));
    expect(options.assetFileName).toBe("electron-gpui.node");
    expect(options.build).toBe(true);
  });

  it("rejects file names that aren't plain .node files", () => {
    expect(() => resolveOptions({ fileName: "../x.node" })).toThrow(/plain file name/);
    expect(() => resolveOptions({ fileName: "addon.dylib" })).toThrow(/plain file name/);
  });
});

describe("assetFileName", () => {
  it("gives changed development addons separate paths and keeps identical content stable", () => {
    const first = developmentAsset("native/addon.node", new Uint8Array([1]));
    expect(first).toMatch(/^native\/addon\.[a-f0-9]{16}\.node$/);
    expect(developmentAsset("native/addon.node", new Uint8Array([1]))).toBe(first);
    expect(developmentAsset("native/addon.node", new Uint8Array([2]))).not.toBe(first);
  });
  it("joins a relative asset directory", () => {
    expect(assetFileName("a.node", "main")).toBe("main/a.node");
    expect(assetFileName("a.node", "main\\sub")).toBe("main/sub/a.node");
  });

  it("refuses directories outside the output", () => {
    expect(() => assetFileName("a.node", "../x")).toThrow(/inside the output/);
    expect(() => assetFileName("a.node", "/abs")).toThrow(/inside the output/);
    expect(() => assetFileName("a.node", ".")).toThrow(/inside the output/);
  });
});

describe("isCrateInput", () => {
  const crate = path.resolve("/app/native");
  it("matches Rust sources and manifests", () => {
    expect(isCrateInput(crate, "/app/native/src/lib.rs")).toBe(true);
    expect(isCrateInput(crate, "/app/native/src/views/editor.rs")).toBe(true);
    expect(isCrateInput(crate, "/app/native/Cargo.toml")).toBe(true);
    expect(isCrateInput(crate, "/app/native/build.rs")).toBe(true);
  });

  it("ignores build output and unrelated files", () => {
    expect(isCrateInput(crate, "/app/native/index.node")).toBe(false);
    expect(isCrateInput(crate, "/app/native/target/debug/build/x/out/gen.rs")).toBe(false);
    expect(isCrateInput(crate, "/app/src/main.js")).toBe(false);
    expect(isCrateInput(crate, "/app/other/lib.rs")).toBe(false);
  });
});

describe("ensureBuild", () => {
  it("shares one in-flight build and reruns once if invalidated meanwhile", async () => {
    const options = resolveOptions({ cwd: "/app", crate: "dedupe" });
    let runs = 0;
    let release!: () => void;
    const run = () => {
      runs += 1;
      return runs === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    };

    const first = ensureBuild(options, run);
    const second = ensureBuild(options, run);
    invalidateBuild(options);
    release();
    await Promise.all([first, second]);
    expect(runs).toBe(2);
  });

  it("propagates build failures", async () => {
    const options = resolveOptions({ cwd: "/app", crate: "failing" });
    await expect(ensureBuild(options, () => Promise.reject(new Error("cargo failed")))).rejects.toThrow(
      "cargo failed",
    );
  });
});

describe("resolveAddonPath", () => {
  const code = addonModuleCode(ADDON_PATH_PLACEHOLDER);

  it("points from the chunk to the asset", () => {
    expect(resolveAddonPath(code, "main.js", "electron-gpui.node")).toContain('"electron-gpui.node"');
    expect(resolveAddonPath(code, "main/index.js", "electron-gpui.node")).toContain(
      '"../electron-gpui.node"',
    );
    expect(resolveAddonPath(code, "main/index.js", "main/native/a.node")).toContain('"native/a.node"');
  });

  it("leaves chunks without the addon alone", () => {
    expect(resolveAddonPath("export {}", "main.js", "electron-gpui.node")).toBeUndefined();
  });
});

describe("Windows development loading", () => {
  it("loads process-owned copies and preserves an older addon across rebuilds", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "egpui-copy-"));
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const originalDlopen = process.dlopen.bind(process);
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const loaded: string[] = [];
    process.dlopen = ((_target: unknown, file: string) => {
      loaded.push(file);
    }) as typeof process.dlopen;
    try {
      const build = async (version: string) => {
        writeFileSync(path.join(project, "addon.node"), version);
        const module = path.join(project, `module-${version}.mjs`);
        writeFileSync(module, addonModuleCode("addon.node", undefined, true));
        await import(pathToFileURL(module).href);
      };
      await build("first");
      await build("second");
      expect(loaded[0]).not.toBe(loaded[1]);
      expect(path.dirname(loaded[0]!)).toBe(path.join(tmpdir(), "electron-gpui-addons", String(process.pid)));
      expect(readFileSync(loaded[0]!, "utf8")).toBe("first");
      expect(readFileSync(loaded[1]!, "utf8")).toBe("second");
    } finally {
      process.dlopen = originalDlopen;
      Object.defineProperty(process, "platform", descriptor);
      for (const file of loaded) rmSync(file, { force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("localDependencies", () => {
  const pkg = (id: string, manifest: string, source: string | null = null) => ({
    id,
    name: id,
    manifest_path: path.resolve(manifest),
    source,
  });
  const metadata = {
    packages: [
      pkg("views", "/app/native/Cargo.toml"),
      pkg("theme", "/app/theme/Cargo.toml"),
      pkg("icons", "/app/icons/Cargo.toml"),
      pkg("unrelated", "/app/tools/Cargo.toml"),
      pkg("gpui", "/app/vendor/zed/crates/gpui/Cargo.toml"),
      pkg("serde", "/registry/serde/Cargo.toml", "registry+https://github.com/rust-lang/crates.io-index"),
    ],
    resolve: {
      nodes: [
        { id: "views", deps: [{ pkg: "theme" }, { pkg: "gpui" }, { pkg: "serde" }] },
        { id: "theme", deps: [{ pkg: "icons" }] },
        { id: "icons", deps: [] },
        { id: "unrelated", deps: [] },
        { id: "gpui", deps: [] },
        { id: "serde", deps: [] },
      ],
    },
  };

  it("returns local crates reachable from the views crate, skipping vendored and registry crates", () => {
    expect(localDependencies(metadata, path.resolve("/app/native/Cargo.toml"))).toEqual([
      path.resolve("/app/icons"),
      path.resolve("/app/theme"),
    ]);
  });
});
