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

  constructor(
    private readonly projectDir: string,
    private readonly options: ElectronLaunchOptions = {},
    private readonly binary: () => string = () => resolveElectronBinary(projectDir),
  ) {}

  get running(): boolean {
    return this.#child !== undefined;
  }

  async restart(): Promise<void> {
    await this.stop();
    this.#start();
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = undefined;
    this.#stopping ??= new Promise<void>((resolve) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    }).finally(() => {
      this.#stopping = undefined;
    });
    await this.#stopping;
  }

  #start(): void {
    const child = spawn(this.binary(), [this.projectDir, ...(this.options.args ?? [])], {
      cwd: this.projectDir,
      stdio: "inherit",
      env: { ...process.env, ELECTRON_GPUI_DEV: "1" },
    });
    this.#child = child;
    child.once("exit", (code, signal) => {
      // The user quit the app (not a restart we asked for): stop watching too.
      if (this.#child === child) {
        this.#child = undefined;
        process.exit(code ?? (signal ? 1 : 0));
      }
    });
  }
}
