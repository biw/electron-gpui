import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { rolldown } from "rolldown";
import { rollup } from "rollup";
import { build as viteBuild, mergeConfig, type Plugin, type UserConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import webpack from "webpack";
import esbuildPlugin from "../src/esbuild.js";
import rolldownPlugin from "../src/rolldown.js";
import rollupPlugin from "../src/rollup.js";
import vitePlugin from "../src/vite.js";
import webpackPlugin from "../src/webpack.js";

let project: string;
let entry: string;
let out: string;
const realDlopen = process.dlopen.bind(process);

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "electron-gpui-unplugin-"));
  mkdirSync(path.join(project, "native"));
  mkdirSync(path.join(project, "src"));
  writeFileSync(path.join(project, "package.json"), '{ "name": "app" }');
  writeFileSync(path.join(project, "native", "index.node"), "fake addon");
  entry = path.join(project, "src", "main.js");
  writeFileSync(entry, 'import addon from "virtual:electron-gpui/addon";\nexport default addon;\n');
  out = path.join(project, "out");
  // Record which file the bundle loads instead of loading a real addon.
  process.dlopen = ((target: { exports: unknown }, file: string) => {
    target.exports = { loadedFrom: file };
  }) as typeof process.dlopen;
});

afterEach(() => {
  process.dlopen = realDlopen;
  rmSync(project, { recursive: true, force: true });
});

const options = () => ({ cwd: project, build: false });

async function loadEsm(file: string): Promise<{ loadedFrom: string }> {
  return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default;
}

function loadCjs(file: string): { loadedFrom: string } {
  const exports = createRequire(import.meta.url)(file);
  return exports.default ?? exports;
}

function expectLoads(addon: { loadedFrom: string }, expected: string): void {
  expect(existsSync(expected)).toBe(true);
  expect(realpathSync(addon.loadedFrom)).toBe(realpathSync(expected));
}

describe("bundler adapters", () => {
  it("rollup (ESM, nested entry)", async () => {
    const bundle = await rollup({ input: entry, external: [/^node:/], plugins: [rollupPlugin(options())] });
    await bundle.write({ dir: out, format: "es", entryFileNames: "main/index.mjs" });
    expectLoads(await loadEsm(path.join(out, "main/index.mjs")), path.join(out, "electron-gpui.node"));
  });

  it("rollup (CommonJS)", async () => {
    const bundle = await rollup({ input: entry, external: [/^node:/], plugins: [rollupPlugin(options())] });
    await bundle.write({ dir: out, format: "cjs", entryFileNames: "main.cjs", exports: "named" });
    expectLoads(loadCjs(path.join(out, "main.cjs")), path.join(out, "electron-gpui.node"));
  });

  it("rolldown", async () => {
    const bundle = await rolldown({ input: entry, platform: "node", plugins: [rolldownPlugin(options())] });
    await bundle.write({ dir: out, format: "esm", entryFileNames: "main.mjs" });
    expectLoads(await loadEsm(path.join(out, "main.mjs")), path.join(out, "electron-gpui.node"));
  });

  it("vite (SSR build, custom asset directory)", async () => {
    await viteBuild({
      configFile: false,
      logLevel: "silent",
      root: project,
      plugins: [vitePlugin({ ...options(), assetDirectory: "native" })],
      build: {
        ssr: entry,
        outDir: out,
        rollupOptions: { output: { format: "es", entryFileNames: "main.mjs" } },
      },
    });
    expectLoads(await loadEsm(path.join(out, "main.mjs")), path.join(out, "native", "electron-gpui.node"));
  });

  it("vite (SSR build, CommonJS output in a subdirectory)", async () => {
    await viteBuild({
      configFile: false,
      logLevel: "silent",
      root: project,
      plugins: [vitePlugin(options())],
      build: {
        ssr: entry,
        outDir: out,
        rollupOptions: { output: { format: "cjs", entryFileNames: "main/index.cjs" } },
      },
    });
    expectLoads(loadCjs(path.join(out, "main/index.cjs")), path.join(out, "electron-gpui.node"));
  });

  it("rolldown (nested entry, CommonJS)", async () => {
    const bundle = await rolldown({ input: entry, platform: "node", plugins: [rolldownPlugin(options())] });
    await bundle.write({ dir: out, format: "cjs", entryFileNames: "main/index.cjs" });
    expectLoads(loadCjs(path.join(out, "main/index.cjs")), path.join(out, "electron-gpui.node"));
  });

  it("webpack", async () => {
    await new Promise<void>((resolve, reject) => {
      webpack(
        {
          mode: "none",
          target: "node",
          context: project,
          entry,
          output: { path: out, filename: "main.cjs", library: { type: "commonjs2" } },
          plugins: [webpackPlugin(options())],
        },
        (error, stats) => (error || stats?.hasErrors() ? reject(error ?? stats?.toString()) : resolve()),
      );
    });
    expectLoads(loadCjs(path.join(out, "main.cjs")), path.join(out, "electron-gpui.node"));
  });

  it("esbuild (outdir)", async () => {
    await esbuild({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outdir: out,
      outExtension: { ".js": ".mjs" },
      plugins: [esbuildPlugin(options())],
      logLevel: "silent",
    });
    expectLoads(await loadEsm(path.join(out, "main.mjs")), path.join(out, "electron-gpui.node"));
  });

  it("esbuild (outfile)", async () => {
    const outfile = path.join(out, "app", "main.mjs");
    await esbuild({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      plugins: [esbuildPlugin(options())],
      logLevel: "silent",
    });
    expectLoads(await loadEsm(outfile), path.join(out, "app", "electron-gpui.node"));
  });
});

describe("vite watch include", () => {
  async function merged(user: UserConfig): Promise<UserConfig> {
    const plugin = vitePlugin() as Plugin;
    const hook = plugin.config as (config: UserConfig, env: unknown) => UserConfig | Promise<UserConfig>;
    return mergeConfig(user, await hook(user, { command: "build", mode: "development" }));
  }

  it("keeps the hot-reload restart trigger watched when an include filter is set", async () => {
    const config = await merged({ build: { watch: { include: ["src/**"] } } });
    expect(config.build?.watch?.include).toEqual(["src/**", "**/electron-gpui-hot/*/rebuild-trigger"]);
  });

  it("leaves watching unrestricted when there's no include filter", async () => {
    const config = await merged({ build: { watch: {} } });
    expect(config.build?.watch?.include).toBeUndefined();
    expect((await merged({})).build?.watch).toBeUndefined();
  });
});
