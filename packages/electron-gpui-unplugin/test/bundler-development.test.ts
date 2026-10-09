import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { context as esbuildContext } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import webpack from "webpack";
import esbuildPlugin from "../src/esbuild.js";
import webpackPlugin from "../src/webpack.js";

let project: string;
let entry: string;
let out: string;
let loaded: string[];
const require = createRequire(import.meta.url);
const realDlopen = process.dlopen.bind(process);

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "electron-gpui-development-"));
  entry = path.join(project, "main.js");
  out = path.join(project, "out");
  mkdirSync(path.join(project, "native/src"), { recursive: true });
  writeFileSync(path.join(project, "package.json"), '{"name":"app"}');
  writeFileSync(entry, 'import addon from "virtual:electron-gpui/addon"; export default addon;');
  writeFileSync(path.join(project, "native/src/lib.rs"), "fn value() { 1 }\n");
  loaded = [];
  process.dlopen = ((target: { exports: object }, file: string) => {
    loaded.push(file);
    target.exports = { loadedFrom: file };
  }) as typeof process.dlopen;
});

afterEach(() => {
  process.dlopen = realDlopen;
  for (const file of loaded) rmSync(file, { force: true });
  rmSync(project, { recursive: true, force: true });
});

function writeAddon(version: string): string {
  // Use an allocation large enough to resemble native files rather than a
  // pooled Node Buffer; webpack's asset adapter consumes the backing buffer.
  const bytes = `${version}:${project}\n${" ".repeat(16 * 1024)}`;
  writeFileSync(path.join(project, "native/index.node"), bytes);
  return bytes;
}

async function loadWindows(file: string): Promise<{ loadedFrom: string }> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    if (file.endsWith(".cjs")) {
      delete require.cache[require.resolve(file)];
      const exports = require(file);
      return exports.default ?? exports;
    }
    return (await import(`${pathToFileURL(file).href}?build=${loaded.length}`)).default;
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

function expectCopy(addon: { loadedFrom: string }, bytes: string): void {
  expect(path.dirname(addon.loadedFrom)).toBe(
    path.join(tmpdir(), "electron-gpui-addons", String(process.pid)),
  );
  expect(readFileSync(addon.loadedFrom, "utf8")).toBe(bytes);
}

it.each(["outdir", "outfile"] as const)(
  "esbuild %s preserves a loaded addon across context rebuilds",
  async (output) => {
    const file = path.join(out, "main.mjs");
    const build = await esbuildContext({
      absWorkingDir: project,
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      ...(output === "outdir" ? { outdir: out, outExtension: { ".js": ".mjs" } } : { outfile: file }),
      plugins: [esbuildPlugin({ cwd: project, build: false, release: false })],
      logLevel: "silent",
    });
    try {
      const firstBytes = writeAddon("first");
      await build.rebuild();
      const first = await loadWindows(file);
      expectCopy(first, firstBytes);
      const secondBytes = writeAddon("second");
      await build.rebuild();
      const second = await loadWindows(file);
      expectCopy(second, secondBytes);
      expect(second.loadedFrom).not.toBe(first.loadedFrom);
      expect(readFileSync(first.loadedFrom, "utf8")).toBe(firstBytes);
      expect(
        readdirSync(out).filter((name) => /^electron-gpui\.[a-f0-9]{16}\.node$/.test(name)),
      ).toHaveLength(2);
      expect(existsSync(path.join(out, "electron-gpui.node"))).toBe(false);
    } finally {
      await build.dispose();
    }
  },
);

it("webpack watch preserves a loaded addon after a native source edit", async () => {
  const firstBytes = writeAddon("first");
  const file = path.join(out, "main.cjs");
  const compiler = webpack({
    mode: "development",
    target: "node",
    context: project,
    entry,
    output: { path: out, filename: "main.cjs", library: { type: "commonjs2" } },
    plugins: [webpackPlugin({ cwd: project, build: false, release: false })],
  });
  let buildError: Error | null | undefined;
  let stats: webpack.Stats | undefined;
  const watcher = compiler.watch({ aggregateTimeout: 20 }, (error, result) => {
    buildError = error;
    stats = result;
  });
  if (!watcher) throw new Error("webpack watcher did not start");
  async function waitForAddon(bytes: string): Promise<void> {
    await vi.waitFor(
      () => {
        expect(buildError).toBeFalsy();
        expect(stats?.hasErrors()).toBe(false);
        const asset = Object.keys(stats!.compilation.assets).find((name) => name.endsWith(".node"));
        expect(asset).toMatch(/^electron-gpui\.[a-f0-9]{16}\.node$/);
        expect(readFileSync(path.join(out, asset!), "utf8")).toBe(bytes);
      },
      { timeout: 10_000 },
    );
  }
  try {
    await waitForAddon(firstBytes);
    const first = await loadWindows(file);
    expectCopy(first, firstBytes);
    const secondBytes = writeAddon("second");
    writeFileSync(path.join(project, "native/src/lib.rs"), "fn value() { 2 }\n");
    await waitForAddon(secondBytes);
    const second = await loadWindows(file);
    expectCopy(second, secondBytes);
    expect(second.loadedFrom).not.toBe(first.loadedFrom);
    expect(readFileSync(first.loadedFrom, "utf8")).toBe(firstBytes);
    expect(existsSync(path.join(out, "electron-gpui.node"))).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      watcher.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
    delete require.cache[file];
  }
}, 30_000);
