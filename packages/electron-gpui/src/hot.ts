import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Where the dev server (electron-gpui-unplugin) and this app exchange hot-patch
 * files. Attached to the addon by `virtual:electron-gpui/addon` in dev builds.
 */
export interface HotConfig {
  dir: string;
}

/** The addon exports used for hot patching (dev builds of the SDK). */
export interface HotAddon {
  hotAnchor(): string;
  applyHotPatch(jumpTableJson: string): void;
}

export const HOT_CONFIG_KEY = "__electronGpuiHot";

/** Hot config attached to an addon by the bundler plugin, if any. */
export function hotConfigOf(addon: object): HotConfig | undefined {
  const config = (addon as Record<string, unknown>)[HOT_CONFIG_KEY];
  return config && typeof (config as HotConfig).dir === "string" ? (config as HotConfig) : undefined;
}

function writeAtomic(file: string, contents: string): void {
  const staging = `${file}.${process.pid}.tmp`;
  writeFileSync(staging, contents);
  renameSync(staging, file);
}

/**
 * Protocol (all files in `config.dir`):
 * - the app writes `app.json` — `{ pid, anchor }` — so patches can be built for it;
 * - the dev server writes `patch-<id>.json` (a Subsecond jump table);
 * - the app applies it and writes `result-<id>.json` — `{ ok, error? }`.
 */
export function startHotClient(addon: HotAddon, config: HotConfig, onApplied?: () => void): () => void {
  const { dir } = config;
  mkdirSync(dir, { recursive: true });
  const appFile = join(dir, "app.json");
  writeAtomic(appFile, JSON.stringify({ pid: process.pid, anchor: addon.hotAnchor() }));

  const handled = new Set<string>();
  const applyPending = (name: string): void => {
    const match = /^patch-(\d+)\.json$/.exec(name);
    if (!match || handled.has(name)) return;
    const file = join(dir, name);
    if (!existsSync(file)) return;
    handled.add(name);
    const id = match[1];
    const started = performance.now();
    let result: { ok: boolean; error?: string; ms?: number };
    try {
      addon.applyHotPatch(readFileSync(file, "utf8"));
      result = { ok: true, ms: Math.round(performance.now() - started) };
      onApplied?.();
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    rmSync(file, { force: true });
    writeAtomic(join(dir, `result-${id}.json`), JSON.stringify(result));
    // The file is gone, so the name can be reused (e.g. by a restarted dev server).
    handled.delete(name);
  };

  // File watching can miss files created in quick succession on macOS, so also
  // scan the directory periodically. Both paths are idempotent.
  const watcher = watch(dir, (_event, name) => name && applyPending(name.toString()));
  const scan = (): void => {
    for (const name of readdirSync(dir)) applyPending(name);
  };
  const poll = setInterval(scan, 250);
  poll.unref();
  scan();
  const stop = (): void => {
    clearInterval(poll);
    watcher.close();
    try {
      const current = JSON.parse(readFileSync(appFile, "utf8")) as { pid?: number };
      if (current.pid === process.pid) rmSync(appFile, { force: true });
    } catch {
      // Already gone or replaced by a newer app instance.
    }
  };
  process.once("exit", stop);
  return stop;
}
