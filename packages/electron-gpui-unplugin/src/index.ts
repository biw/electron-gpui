import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createUnplugin } from "unplugin";
import {
  ADDON_PATH_PLACEHOLDER,
  addonModuleCode,
  crateWatchFiles,
  developmentAsset,
  type ElectronGpuiOptions,
  ensureBuild,
  invalidateBuild,
  isCrateInput,
  localDependencyDirs,
  RESOLVED_VIRTUAL_MODULE_ID,
  resolveAddonPath,
  resolveOptions,
  VIRTUAL_MODULE_ID,
} from "./core.js";

import { HotSession, REBUILD_TRIGGER_GLOB } from "./hot.js";
import { ElectronLauncher } from "./launcher.js";

export type { ElectronGpuiOptions } from "./core.js";
export { VIRTUAL_MODULE_ID } from "./core.js";
export type { ElectronLaunchOptions } from "./launcher.js";

/**
 * Builds your GPUI views crate before each bundle, emits the `.node` addon next
 * to the output, and provides `virtual:electron-gpui/addon`, which loads it:
 *
 * ```js
 * import { createGpui } from "electron-gpui";
 * import addon from "virtual:electron-gpui/addon";
 *
 * const gpui = createGpui(addon);
 * ```
 */
export const electronGpui = /* #__PURE__ */ createUnplugin<ElectronGpuiOptions | undefined>(
  (rawOptions, meta) => {
    const options = resolveOptions(rawOptions);
    // Rollup-family hosts know each chunk's output path, so the addon's relative
    // path is filled in per chunk. webpack and esbuild load it beside the bundle.
    const isRollupFamily =
      meta.framework === "rollup" || meta.framework === "vite" || meta.framework === "rolldown";
    const isEsbuild = meta.framework === "esbuild";
    let needsBuild = true;
    let esbuildOutput: { absWorkingDir?: string; outdir?: string; outfile?: string } | undefined;
    let watchMode = false;
    let launcher: ElectronLauncher | undefined;
    let restartTimer: NodeJS.Timeout | undefined;
    let watcherClosed = false;
    let hot: HotSession | undefined;
    let hotChecked = false;
    let dependencyDirs: string[] | undefined;
    let emittedAddon = options.assetFileName;
    let generatedModule: string | undefined;

    function developmentAddon(): boolean {
      // webpack and esbuild have no common watch-mode signal. Protect all of
      // their debug builds, including esbuild context.rebuild() calls.
      return !options.release && (watchMode || meta.framework === "webpack" || isEsbuild);
    }

    /** Local crates the views crate depends on (watch mode only). */
    function localDependencies(): string[] {
      dependencyDirs ??= watchMode ? localDependencyDirs(options.crateDir) : [];
      return dependencyDirs;
    }

    /** Hot reload runs for watch-mode debug builds with Rollup-family bundlers. */
    function hotSession(): HotSession | undefined {
      if (hotChecked) return hot;
      hotChecked = true;
      if (!isRollupFamily || !watchMode || options.release || !options.build || rawOptions?.hot === false) {
        return undefined;
      }
      const session = new HotSession(options, localDependencies());
      if (session.supported) {
        hot = session;
      } else {
        console.log("[electron-gpui] this SDK has no hot-patch tool; using live reload (restarts) instead");
      }
      return hot;
    }

    // Restart once per rebuild, after every output of that build is written.
    function scheduleLaunch(): void {
      if (watcherClosed || !rawOptions?.electron || !watchMode) return;
      launcher ??= new ElectronLauncher(
        options.projectDir,
        typeof rawOptions.electron === "object" ? rawOptions.electron : {},
      );
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (!watcherClosed)
          launcher?.restart().catch((error: unknown) => console.error("electron-gpui:", error));
      }, 50);
    }

    async function closeWatcher(): Promise<void> {
      watcherClosed = true;
      clearTimeout(restartTimer);
      hot?.stop();
      await launcher?.stop();
    }

    function readAddon(): Buffer {
      if (!existsSync(options.builtAddon)) {
        throw new Error(
          `electron-gpui: ${options.builtAddon} doesn't exist. ` +
            (options.build
              ? "The build didn't produce it."
              : "Run `electron-gpui build` first, or remove `build: false`."),
        );
      }
      return readFileSync(options.builtAddon);
    }

    function renderChunk(code: string, chunk: { fileName: string }) {
      const resolved = resolveAddonPath(code, chunk.fileName, emittedAddon);
      return resolved === undefined ? null : { code: resolved, map: null };
    }

    return {
      name: "electron-gpui",
      enforce: "pre",

      async buildStart() {
        if (watcherClosed) return;
        // Rollup and Rolldown report watch mode here; Vite in configResolved.
        const meta = (this as { meta?: { watchMode?: boolean } }).meta;
        if (meta?.watchMode) watchMode = true;
        // Watch builds are for development: default to fast, patchable debug builds.
        if (rawOptions?.release === undefined && watchMode) options.release = false;

        const session = hotSession();
        if (session) {
          // The session builds the crate and watches it itself; the bundler only
          // rebuilds (restarting the app) when the session touches the trigger.
          if (needsBuild) {
            await session.fatBuild();
            if (watcherClosed) return;
            session.start();
          }
          needsBuild = false;
          this.addWatchFile(session.triggerFile);
        } else {
          if (options.build && needsBuild) await ensureBuild(options);
          if (watcherClosed) return;
          needsBuild = false;
          // unplugin's esbuild adapter only takes watch files from resolve/load/transform.
          if (!isEsbuild) {
            for (const dir of [options.crateDir, ...localDependencies()]) {
              for (const file of crateWatchFiles(dir)) this.addWatchFile(file);
            }
          }
        }
        const source = readAddon();
        const development = developmentAddon();
        emittedAddon = development ? developmentAsset(options.assetFileName, source) : options.assetFileName;
        if (generatedModule) {
          writeFileSync(
            generatedModule,
            addonModuleCode(path.posix.basename(emittedAddon), undefined, development),
          );
        }

        if (isEsbuild && esbuildOutput?.outfile) {
          // An outfile defines the bundle's directory; put the addon beside it.
          const outfile = path.resolve(esbuildOutput.absWorkingDir ?? process.cwd(), esbuildOutput.outfile);
          const destination = path.join(path.dirname(outfile), path.posix.basename(emittedAddon));
          mkdirSync(path.dirname(destination), { recursive: true });
          copyFileSync(options.builtAddon, destination);
          return;
        }
        if (isEsbuild && !esbuildOutput?.outdir) {
          throw new Error("electron-gpui: the esbuild plugin needs `outdir` or `outfile`");
        }
        this.emitFile({ type: "asset", fileName: emittedAddon, source });
      },

      resolveId(id) {
        return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : undefined;
      },

      loadInclude(id) {
        return id === RESOLVED_VIRTUAL_MODULE_ID;
      },

      load(id) {
        if (id !== RESOLVED_VIRTUAL_MODULE_ID) return;
        return addonModuleCode(
          isRollupFamily ? ADDON_PATH_PLACEHOLDER : path.posix.basename(emittedAddon),
          hot?.dir,
          developmentAddon(),
        );
      },

      writeBundle() {
        if (isRollupFamily) scheduleLaunch();
      },

      watchChange(id) {
        if (!hot && [options.crateDir, ...(dependencyDirs ?? [])].some((dir) => isCrateInput(dir, id))) {
          needsBuild = true;
          invalidateBuild(options);
        }
      },

      rollup: { renderChunk, closeWatcher },
      rolldown: { renderChunk, closeWatcher },
      vite: {
        // Electron's main process is a Node (SSR-style) build; keep emitted assets.
        config(config) {
          // A watch `include` filter also drops files plugins add with `addWatchFile`,
          // which would stop Rust rebuilds from restarting the app. Vite concatenates
          // the arrays when it merges this in.
          const include = config.build?.watch?.include;
          return {
            build: {
              emitAssets: true,
              ssrEmitAssets: true,
              ...(include ? { watch: { include: [REBUILD_TRIGGER_GLOB] } } : {}),
            },
          };
        },
        configResolved(config) {
          watchMode = Boolean(config.build.watch);
        },
        renderChunk,
        closeWatcher,
      },

      webpack(compiler) {
        // webpack rejects `virtual:` URLs before plugins can resolve them, so point
        // the import at a generated file with the same code.
        const generated = path.join(options.projectDir, "node_modules", ".electron-gpui", "addon.mjs");
        generatedModule = generated;
        mkdirSync(path.dirname(generated), { recursive: true });
        writeFileSync(generated, addonModuleCode(path.posix.basename(emittedAddon)));
        new compiler.webpack.NormalModuleReplacementPlugin(/^virtual:electron-gpui\/addon$/, (resource) => {
          resource.request = generated;
        }).apply(compiler);
      },

      esbuild: {
        setup(build) {
          esbuildOutput = {
            absWorkingDir: build.initialOptions.absWorkingDir,
            outdir: build.initialOptions.outdir,
            outfile: build.initialOptions.outfile,
          };
        },
      },
    };
  },
);
