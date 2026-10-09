import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ElectronLaunchOptions } from "./launcher.js";

/** Import this from your Electron main process to get the bundled addon. */
export const VIRTUAL_MODULE_ID = "virtual:electron-gpui/addon";
export const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

export interface ElectronGpuiOptions {
  /** Project directory (contains package.json). Defaults to the current directory. */
  cwd?: string;
  /** Your views crate, relative to `cwd`. Defaults to `native`. */
  crate?: string;
  /** Run `electron-gpui build` before bundling. Defaults to true. */
  build?: boolean;
  /**
   * Build with `--release`. Defaults to true when `NODE_ENV` is `production`,
   * except in watch mode.
   */
  release?: boolean;
  /** Build arm64 + x64 and combine them (`--universal`). Defaults to false. */
  universal?: boolean;
  /** File name of the emitted addon. Defaults to `electron-gpui.node`. */
  fileName?: string;
  /**
   * Output subdirectory for the addon, relative to the bundle's output directory.
   * Rollup, Rolldown and Vite always compute the right path from your code to the
   * addon. With webpack and esbuild the addon is loaded from the directory of the
   * bundle that imports it, so set this to that bundle's subdirectory if it isn't
   * at the output root.
   */
  assetDirectory?: string;
  /**
   * In watch mode, launch the Electron app after the first build and restart it
   * after each rebuild. Leave off if another tool (electron-vite, Electron Forge)
   * already runs your app. Rollup, Rolldown and Vite only.
   */
  electron?: boolean | ElectronLaunchOptions;
  /**
   * In watch mode, hot-patch Rust changes into the running app instead of
   * restarting it, when the change allows. Defaults to true. Rollup, Rolldown and
   * Vite only; debug builds only.
   */
  hot?: boolean;
}

export interface ResolvedOptions {
  projectDir: string;
  crateDir: string;
  build: boolean;
  release: boolean;
  universal: boolean;
  /** Output-relative path of the emitted addon. */
  assetFileName: string;
  /** Where `electron-gpui build` writes the addon. */
  builtAddon: string;
}

export function resolveOptions(options: ElectronGpuiOptions = {}): ResolvedOptions {
  const projectDir = path.resolve(options.cwd ?? process.cwd());
  const crateDir = path.resolve(projectDir, options.crate ?? "native");
  const fileName = options.fileName ?? "electron-gpui.node";
  if (fileName.includes("/") || fileName.includes("\\") || !fileName.endsWith(".node")) {
    throw new Error(`electron-gpui: fileName must be a plain file name ending in .node, got ${fileName}`);
  }
  return {
    projectDir,
    crateDir,
    build: options.build ?? true,
    release: options.release ?? process.env.NODE_ENV === "production",
    universal: options.universal ?? false,
    assetFileName: assetFileName(fileName, options.assetDirectory),
    builtAddon: path.join(crateDir, "index.node"),
  };
}

/** Output-relative asset path, refusing anything that escapes the output directory. */
export function assetFileName(fileName: string, assetDirectory?: string): string {
  if (!assetDirectory) return fileName;
  const normalized = path.posix.normalize(assetDirectory.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("electron-gpui: assetDirectory must be a relative directory inside the output directory");
  }
  return path.posix.join(normalized, fileName);
}

/** True for files whose changes require rebuilding the crate. */
export function isCrateInput(crateDir: string, file: string): boolean {
  const relative = path.relative(crateDir, path.resolve(file));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const [first] = relative.split(path.sep);
  if (first === "target" || first === "node_modules") return false;
  return (
    relative.endsWith(".rs") ||
    relative === "Cargo.toml" ||
    relative === "Cargo.lock" ||
    relative === "rust-toolchain.toml"
  );
}

interface CargoMetadata {
  packages: { id: string; name: string; manifest_path: string; source: string | null }[];
  resolve: { nodes: { id: string; deps: { pkg: string }[] }[] } | null;
}

/**
 * Directories of local (path) crates the views crate depends on, directly or
 * not — your own workspace crates. Vendored code (any `vendor/` directory) is
 * left out. Changes to these can't be hot-patched, so they rebuild and restart.
 */
export function localDependencyDirs(crateDir: string): string[] {
  const manifest = path.resolve(crateDir, "Cargo.toml");
  if (!existsSync(manifest)) return [];
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", manifest], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ) as CargoMetadata;
  return localDependencies(metadata, manifest);
}

export function localDependencies(metadata: CargoMetadata, manifest: string): string[] {
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const root = metadata.packages.find((p) => path.resolve(p.manifest_path) === manifest);
  const nodes = new Map(metadata.resolve?.nodes.map((n) => [n.id, n]) ?? []);
  if (!root) return [];

  const seen = new Set<string>([root.id]);
  const queue = [root.id];
  const dirs: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      const pkg = byId.get(dep.pkg);
      if (!pkg || pkg.source !== null) continue; // registry and git dependencies
      const dir = path.dirname(pkg.manifest_path);
      if (dir.split(path.sep).includes("vendor")) continue;
      dirs.push(dir);
      queue.push(dep.pkg);
    }
  }
  return dirs.sort();
}

/** The crate's build inputs, for bundler watch mode. */
export function crateWatchFiles(crateDir: string): string[] {
  const files: string[] = [];
  for (const name of ["Cargo.toml", "Cargo.lock", "build.rs", "rust-toolchain.toml"]) {
    const file = path.join(crateDir, name);
    if (existsSync(file)) files.push(file);
  }
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".rs")) files.push(file);
    }
  };
  walk(path.join(crateDir, "src"));
  return files;
}

/** The project-installed electron-gpui CLI. Never uses npx or a package-manager shim. */
function electronGpuiBin(projectDir: string): string {
  const requireFromProject = createRequire(path.join(projectDir, "package.json"));
  let manifestPath: string;
  try {
    manifestPath = requireFromProject.resolve("electron-gpui/package.json");
  } catch {
    throw new Error(
      `electron-gpui: couldn't resolve the electron-gpui package from ${projectDir}. Install it with \`pnpm add electron-gpui\`.`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["electron-gpui"];
  if (!bin) throw new Error(`electron-gpui: ${manifestPath} doesn't declare the electron-gpui CLI`);
  return path.resolve(path.dirname(manifestPath), bin);
}

export async function runBuild(options: ResolvedOptions): Promise<void> {
  const args = [
    electronGpuiBin(options.projectDir),
    "build",
    options.crateDir,
    ...(options.release ? ["--release"] : []),
    ...(options.universal ? ["--universal"] : []),
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.projectDir, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `electron-gpui build failed ${signal ? `with signal ${signal}` : `with exit code ${code ?? "unknown"}`}`,
          ),
        );
    });
  });
}

interface InFlightBuild {
  promise: Promise<void>;
  invalidated: boolean;
}

const inFlight = new Map<string, InFlightBuild>();

function buildKey(options: ResolvedOptions): string {
  return JSON.stringify([options.crateDir, options.release, options.universal]);
}

/**
 * Share one in-flight build per crate and profile: some hosts (tsdown, Vite with
 * several outputs) start the plugin more than once per bundle. Cargo's own cache
 * makes repeated builds cheap, so finished builds aren't remembered here.
 */
export async function ensureBuild(options: ResolvedOptions, run = runBuild): Promise<void> {
  const key = buildKey(options);
  while (true) {
    let build = inFlight.get(key);
    if (!build) {
      build = { promise: run(options), invalidated: false };
      inFlight.set(key, build);
    }
    try {
      await build.promise;
    } catch (error) {
      if (inFlight.get(key) === build) inFlight.delete(key);
      throw error;
    }
    if (inFlight.get(key) === build) inFlight.delete(key);
    // A source change arrived while this build ran: build once more for it.
    if (!build.invalidated) return;
  }
}

/** Mark a running build stale so `ensureBuild` runs one more pass after it. */
export function invalidateBuild(options: ResolvedOptions): void {
  const build = inFlight.get(buildKey(options));
  if (build) build.invalidated = true;
}

/** Placeholder for the addon's path relative to the output chunk (Rollup-family hosts). */
export const ADDON_PATH_PLACEHOLDER = "__ELECTRON_GPUI_ADDON_PATH__";

/**
 * The virtual module. It loads the addon with `process.dlopen` from a path
 * relative to the bundle file, so no bundler tries to resolve a native require,
 * and it works from both ES module and CommonJS output.
 */
export function addonModuleCode(relativePath: string, hotDir?: string, development = false): string {
  // In hot-reload dev builds, tell electron-gpui's runtime where to exchange patches.
  const hot = hotDir
    ? `Object.defineProperty(addonModule.exports, "__electronGpuiHot", { value: { dir: ${JSON.stringify(hotDir)}, buildId: addonBuildId } });\n`
    : "";
  const copy = development
    ? `
if (process.platform === "win32") {
  const root = join(tmpdir(), "electron-gpui-addons");
  mkdirSync(root, { recursive: true });
  for (const name of readdirSync(root)) {
    if (!/^\\d+$/.test(name) || Number(name) === process.pid) continue;
    try { process.kill(Number(name), 0); }
    catch (error) {
      if (error.code === "ESRCH") {
        try { rmSync(join(root, name), { recursive: true, force: true }); } catch {}
      }
    }
  }
  const directory = join(root, String(process.pid));
  mkdirSync(directory, { recursive: true });
  const copy = join(directory, addonBuildId + ".node");
  if (!existsSync(copy)) copyFileSync(addonPath, copy);
  addonPath = copy;
}
`
    : "";
  return `import { dirname, join } from "node:path";
${development ? 'import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";\nimport { tmpdir } from "node:os";\n' : hotDir ? 'import { readFileSync } from "node:fs";\n' : ""}
${development || hotDir ? 'import { createHash } from "node:crypto";\n' : ""}
import { fileURLToPath } from "node:url";
const bundleDir = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const addonModule = { exports: {} };
let addonPath = join(bundleDir, ${JSON.stringify(relativePath)});
${development || hotDir ? 'const addonBuildId = createHash("sha256").update(readFileSync(addonPath)).digest("hex");\n' : ""}
${copy}process.dlopen(addonModule, addonPath);
${hot}export default addonModule.exports;
`;
}

/** Replace the placeholder with the addon's path relative to `chunkFileName`. */
export function resolveAddonPath(
  code: string,
  chunkFileName: string,
  assetFileName: string,
): string | undefined {
  const quoted = JSON.stringify(ADDON_PATH_PLACEHOLDER);
  if (!code.includes(quoted)) return undefined;
  const relative = path.posix.relative(path.posix.dirname(chunkFileName), assetFileName);
  return code.replaceAll(quoted, JSON.stringify(relative));
}

/** Content-addressed assets prevent replacement of a loaded development addon. */
export function developmentAsset(fileName: string, bytes: Uint8Array): string {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return fileName.replace(/\.node$/, `.${hash}.node`);
}
