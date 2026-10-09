import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export interface ElectronLaunchOptions {
  /** Extra arguments for Electron, after the app directory. */
  args?: string[];
}

/** The Electron binary installed in the project (`require("electron")` returns its path). */
export function resolveElectronBinary(projectDir: string): string {
  try {
    return createRequire(path.join(projectDir, "package.json"))("electron") as string;
  } catch {
    throw new Error(
      `electron-gpui: couldn't resolve electron from ${projectDir}. Install it with \`pnpm add -D electron\`.`,
    );
  }
}

/**
 * Runs the Electron app during watch builds: starts it after the first build and
 * restarts it after later ones. Quitting the app ends the watch process, like
 * other Electron dev launchers.
 */
export class ElectronLauncher {
  #child: ChildProcess | undefined;
  #stopping: Promise<void> | undefined;
  #request = 0;

  constructor(
    private readonly projectDir: string,
    private readonly options: ElectronLaunchOptions = {},
    private readonly binary: () => string = () => resolveElectronBinary(projectDir),
  ) {}

  get running(): boolean {
    return this.#child !== undefined;
  }

  async restart(): Promise<void> {
    const request = ++this.#request;
    await this.#stopChild();
    if (request === this.#request) await this.#start();
  }

  async stop(): Promise<void> {
    ++this.#request;
    await this.#stopChild();
  }

  #stopChild(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const child = this.#child;
    if (!child) return Promise.resolve();
    this.#child = undefined;
    this.#stopping = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        if (error) {
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
            this.#child = child;
          reject(error);
        } else resolve();
      };
      const onExit = (): void => finish();
      const onError = (error: Error): void => finish(error);
      const kill = (signal: NodeJS.Signals): void => {
        try {
          child.kill(signal);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timeout = setTimeout(() => kill("SIGKILL"), 5000);
      child.once("exit", onExit);
      child.once("error", onError);
      kill("SIGTERM");
    }).finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  #start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary(), [this.projectDir, ...(this.options.args ?? [])], {
        cwd: this.projectDir,
        stdio: "inherit",
        env: { ...process.env, ELECTRON_GPUI_DEV: "1" },
      });
      this.#child = child;
      let spawned = false;
      const onSpawn = (): void => {
        spawned = true;
        resolve();
      };
      child.once("spawn", onSpawn);
      child.on("error", (error) => {
        if (!spawned) {
          child.removeListener("spawn", onSpawn);
          if (this.#child === child) this.#child = undefined;
          reject(error);
        } else if (this.#child === child) console.error("electron-gpui:", error);
      });
      child.once("exit", (code, signal) => {
        // The user quit the app (not a restart we asked for): stop watching too.
        if (this.#child === child) {
          this.#child = undefined;
          process.exit(code ?? (signal ? 1 : 0));
        }
      });
    });
  }
}
