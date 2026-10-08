import { execFileSync, spawn } from "node:child_process";
import {
  type Dirent,
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ResolvedOptions } from "./core.js";

const log = (message: string): void => console.log(`[electron-gpui] ${message}`);

/**
 * Matches the file a hot session touches to make the bundler rebuild (restarting
 * the app). A watch `include` filter must keep matching it.
 */
export const REBUILD_TRIGGER_GLOB = "**/electron-gpui-hot/*/rebuild-trigger";

/** Exit codes of `electron-gpui-hotpatch patch`. */
const EXIT_COMPILE_ERROR = 10;

export type ChangeKind = "hot" | "full";

/** Files whose changes always need a full rebuild and restart. */
const FULL_REBUILD_FILES = new Set(["Cargo.toml", "Cargo.lock", "build.rs", "rust-toolchain.toml"]);

/**
 * Struct, enum and union definitions in a Rust source file, as text keyed by
 * name. Subsecond can't patch code whose types change layout, so any change to
 * these needs a restart. Deliberately simple: brace matching ignores strings and
 * comments, which at worst makes a change look structural and restart.
 */
export function typeDefinitions(source: string): Map<string, string> {
  const definitions = new Map<string, string>();
  const pattern = /\b(struct|enum|union)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let end = match.index + match[0].length;
    let depth = 0;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      } else if (ch === ";" && depth === 0) {
        end++;
        break;
      }
    }
    const key = `${match[1]} ${match[2]}`;
    definitions.set(
      key,
      `${definitions.get(key) ?? ""}${source.slice(match.index, end).replace(/\s+/g, " ")}`,
    );
  }
  return definitions;
}

/** Whether `next` changes any type definition in `previous`. */
export function typesChanged(previous: string, next: string): boolean {
  const before = typeDefinitions(previous);
  const after = typeDefinitions(next);
  if (before.size !== after.size) return true;
  for (const [name, text] of before) if (after.get(name) !== text) return true;
  return false;
}

export function classifyChange(
  crateDir: string,
  file: string,
  previous: string | undefined,
  next: string | undefined,
): ChangeKind {
  const relative = path.relative(crateDir, file);
  if (FULL_REBUILD_FILES.has(relative)) return "full";
  if (!file.endsWith(".rs")) return "full";
  // New or deleted files change the module tree.
  if (previous === undefined || next === undefined) return "full";
  return typesChanged(previous, next) ? "full" : "hot";
}

export interface AppInfo {
  pid: number;
  anchor: string;
}

function readApp(dir: string): AppInfo | undefined {
  try {
    const app = JSON.parse(readFileSync(path.join(dir, "app.json"), "utf8")) as AppInfo;
    process.kill(app.pid, 0);
    return app;
  } catch {
    return undefined;
  }
}

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

interface CrateLayout {
  targetDir: string;
  libName: string;
  /** The SDK's `electron-gpui-hotpatch` crate, next to the SDK crate. */
  toolManifest: string | undefined;
}

function crateLayout(crateDir: string): CrateLayout {
  const manifest = path.join(crateDir, "Cargo.toml");
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", manifest], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ) as {
    target_directory: string;
    packages: { name: string; manifest_path: string; targets: { name: string; kind: string[] }[] }[];
  };
  const own = metadata.packages.find((p) => path.resolve(p.manifest_path) === path.resolve(manifest));
  const lib = own?.targets.find((t) => t.kind.includes("cdylib"));
  if (!lib) throw new Error(`electron-gpui: ${manifest} has no cdylib target`);
  const sdk = metadata.packages.find((p) => p.name === "electron-gpui");
  const toolManifest =
    sdk && path.join(path.dirname(sdk.manifest_path), "..", "electron-gpui-hotpatch", "Cargo.toml");
  return {
    targetDir: metadata.target_directory,
    libName: lib.name.replaceAll("-", "_"),
    toolManifest: toolManifest && existsSync(toolManifest) ? toolManifest : undefined,
  };
}

/**
 * The hot-reload dev loop: keeps a patchable build of the views crate, watches
 * its sources, and on each change either sends a hot patch to the running app or
 * rebuilds and asks the bundler to rebuild (which restarts the app).
 */
export class HotSession {
  /** Shared with the app: see `startHotClient` in the electron-gpui package. */
  readonly dir: string;
  /** Touching this makes the bundler rebuild (it's in the bundle's watch list). */
  readonly triggerFile: string;
  readonly #layout: CrateLayout;
  #tool: string | undefined;
  /** Sources of the running full build: patches are built against it, so type
   * definitions are compared with these. */
  #builtSources = new Map<string, string>();
  /** Sources as of the last build or patch, to skip saves that change nothing. */
  #liveSources = new Map<string, string>();
  #watchers: FSWatcher[] = [];
  #pending = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #queue: Promise<void> = Promise.resolve();
  #nextPatchId = 1;

  constructor(
    private readonly options: ResolvedOptions,
    /** Local crates the views crate depends on: changes there rebuild and restart. */
    private readonly dependencyDirs: string[] = [],
  ) {
    this.#layout = crateLayout(options.crateDir);
    const base = path.join(this.#layout.targetDir, "electron-gpui-hot", this.#layout.libName);
    this.dir = path.join(base, "live");
    this.triggerFile = path.join(base, "rebuild-trigger");
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.triggerFile)) writeFileSync(this.triggerFile, "");
    // Patches target the app process that was running when they were built; any
    // left by an earlier dev server are stale.
    for (const name of safeReaddir(this.dir)) {
      if (/^(?:patch|result)-\d+\.json$|^pending\.json\.tmp$/.test(name.name)) {
        rmSync(path.join(this.dir, name.name), { force: true });
      }
    }
  }

  /** False when the SDK has no patch tool (older SDK or unusual layout). */
  get supported(): boolean {
    return this.#layout.toolManifest !== undefined;
  }

  /** Build the patch tool from the SDK's own checkout, so versions always match. */
  async #ensureTool(): Promise<string> {
    if (this.#tool) return this.#tool;
    const manifest = this.#layout.toolManifest;
    if (!manifest) throw new Error("electron-gpui: this SDK version has no hot-patch tool");
    const toolTarget = path.join(this.#layout.targetDir, "electron-gpui-hot", "tool");
    const code = await run(
      "cargo",
      ["build", "--quiet", "--release", "--manifest-path", manifest, "--target-dir", toolTarget],
      this.options.crateDir,
    );
    if (code !== 0) throw new Error("electron-gpui: building the hot-patch tool failed");
    this.#tool = path.join(toolTarget, "release", "electron-gpui-hotpatch");
    return this.#tool;
  }

  /** Build the addon so it can be patched later, and remember the sources it was built from. */
  async fatBuild(): Promise<void> {
    const tool = await this.#ensureTool();
    const code = await run(
      tool,
      ["fat", this.options.crateDir, this.options.builtAddon],
      this.options.crateDir,
    );
    if (code !== 0) throw new Error("electron-gpui: build failed");
    this.#snapshot();
  }

  #snapshot(): void {
    const sources = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of safeReaddir(dir)) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith(".rs")) sources.set(file, readFileSync(file, "utf8"));
      }
    };
    walk(path.join(this.options.crateDir, "src"));
    const buildScript = path.join(this.options.crateDir, "build.rs");
    if (existsSync(buildScript)) sources.set(buildScript, readFileSync(buildScript, "utf8"));
    this.#builtSources = sources;
    this.#liveSources = new Map(sources);
  }

  /** Start watching the crate and its local dependencies. Changes are handled one batch at a time. */
  start(): void {
    if (this.#watchers.length > 0) return;
    for (const dir of [this.options.crateDir, ...this.dependencyDirs]) {
      this.#watchers.push(watch(dir, { recursive: true }, (_event, name) => this.#onFileEvent(dir, name)));
    }
  }

  #onFileEvent(dir: string, name: string | Buffer | null): void {
    if (!name) return;
    const relative = name.toString();
    const top = relative.split(path.sep)[0];
    if (
      top === "target" ||
      top === "node_modules" ||
      relative.endsWith(".node") ||
      relative.includes(".tmp")
    ) {
      return;
    }
    if (!relative.endsWith(".rs") && !FULL_REBUILD_FILES.has(relative)) return;
    this.#pending.add(path.join(dir, relative));
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      const files = [...this.#pending];
      this.#pending.clear();
      this.#queue = this.#queue.then(() => this.#handle(files)).catch((error: unknown) => log(String(error)));
    }, 80);
  }

  stop(): void {
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
  }

  /** The local dependency crate containing `file`, if any. */
  #dependencyOf(file: string): string | undefined {
    return this.dependencyDirs.find((dir) => !path.relative(dir, file).startsWith(".."));
  }

  async #handle(files: string[]): Promise<void> {
    // Only the views crate is recompiled into patches; other crates need a rebuild.
    const dependency = files.map((file) => this.#dependencyOf(file)).find((dir) => dir !== undefined);
    if (dependency) {
      return this.#fullReload(
        `${path.basename(dependency)} changed (only ${path.basename(this.options.crateDir)} can be hot-patched)`,
      );
    }

    const changed = files.filter((file) => {
      const next = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      return next !== this.#liveSources.get(file);
    });
    if (changed.length === 0) return;

    const reasons = changed
      .map((file) => {
        const next = existsSync(file) ? readFileSync(file, "utf8") : undefined;
        return classifyChange(this.options.crateDir, file, this.#builtSources.get(file), next) === "full"
          ? path.relative(this.options.crateDir, file)
          : undefined;
      })
      .filter((reason) => reason !== undefined);

    if (reasons.length > 0) {
      return this.#fullReload(`${reasons.join(", ")} changed in a way that can't be hot-patched`);
    }
    const app = readApp(this.dir);
    if (!app) return this.#fullReload("no running app to patch");

    const started = performance.now();
    const tool = await this.#ensureTool();
    const pending = path.join(this.dir, "pending.json.tmp");
    const code = await run(
      tool,
      ["patch", this.options.crateDir, app.anchor, pending],
      this.options.crateDir,
    );
    if (code === EXIT_COMPILE_ERROR) {
      log("build failed; fix the errors above and save again");
      return;
    }
    if (code !== 0) return this.#fullReload("the change couldn't be hot-patched");

    const id = this.#nextPatchId++;
    const resultFile = path.join(this.dir, `result-${id}.json`);
    const patchFile = path.join(this.dir, `patch-${id}.json`);
    rmSync(resultFile, { force: true });
    writePatch(pending, app);
    renameSync(pending, patchFile);
    const result = await waitForJson<{ ok: boolean; error?: string }>(resultFile, 10_000);
    rmSync(resultFile, { force: true });
    // Unclaimed (the app is gone or hung): don't leave it for the next app.
    rmSync(patchFile, { force: true });
    if (!result?.ok) {
      return this.#fullReload(
        result ? `the app couldn't apply the patch: ${result.error}` : "the app didn't respond",
      );
    }
    for (const file of changed) {
      if (existsSync(file)) this.#liveSources.set(file, readFileSync(file, "utf8"));
    }
    log(
      `hot-patched ${changed.map((f) => path.relative(this.options.crateDir, f)).join(", ")} in ${Math.round(performance.now() - started)}ms`,
    );
  }

  async #fullReload(reason: string): Promise<void> {
    log(`${reason}; rebuilding and restarting`);
    try {
      await this.fatBuild();
    } catch (error) {
      log(`${error instanceof Error ? error.message : String(error)}; fix the errors above and save again`);
      return;
    }
    // The bundler watches this file: rebuilding the bundle restarts the app.
    writeFileSync(this.triggerFile, String(Date.now()));
  }
}

/**
 * Wrap the jump table the tool wrote to `file` with the process it targets, so
 * the app can refuse a patch built for another process.
 */
export function writePatch(file: string, app: AppInfo): void {
  const table = readFileSync(file, "utf8");
  writeFileSync(file, `{"target":${JSON.stringify({ pid: app.pid, anchor: app.anchor })},"table":${table}}`);
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function waitForJson<T>(file: string, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as T;
      } catch {
        // Partially written; retry.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}
