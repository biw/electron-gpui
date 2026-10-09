import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { watch as rolldownWatch } from "rolldown";
import { watch as rollupWatch } from "rollup";
import { build as viteBuild } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import rolldownPlugin from "../src/rolldown.js";
import rollupPlugin from "../src/rollup.js";
import vitePlugin from "../src/vite.js";

const mocks = vi.hoisted(() => ({
  fatBuild: vi.fn(async () => {}),
  start: vi.fn(),
  stop: vi.fn(),
  restartElectron: vi.fn(async () => {}),
  stopElectron: vi.fn(async () => {}),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => JSON.stringify({ packages: [], resolve: { nodes: [] } })),
}));
vi.mock("../src/hot.js", () => ({
  REBUILD_TRIGGER_GLOB: "**/electron-gpui-hot/*/rebuild-trigger",
  HotSession: class {
    supported = true;
    dir: string;
    triggerFile: string;
    fatBuild = mocks.fatBuild;
    start = mocks.start;
    stop = mocks.stop;
    constructor(options: { crateDir: string }) {
      this.dir = options.crateDir;
      this.triggerFile = path.join(options.crateDir, "rebuild-trigger");
      writeFileSync(this.triggerFile, "");
    }
  },
}));
vi.mock("../src/launcher.js", () => ({
  ElectronLauncher: class {
    restart = mocks.restartElectron;
    stop = mocks.stopElectron;
  },
}));

interface Watcher {
  on(
    event: "event",
    callback: (event: {
      code: string;
      error?: unknown;
      result?: { close(): void | Promise<void> } | null;
    }) => void,
  ): unknown;
  close(): void | Promise<void>;
}

let project: string;
let watcher: Watcher | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  project = mkdtempSync(path.join(tmpdir(), "electron-gpui-bundler-lifecycle-"));
  mkdirSync(path.join(project, "native"));
  writeFileSync(path.join(project, "native/index.node"), "fake addon");
  writeFileSync(
    path.join(project, "main.js"),
    'import addon from "virtual:electron-gpui/addon"; export default addon;',
  );
});

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  rmSync(project, { recursive: true, force: true });
});

async function start(framework: "rollup" | "rolldown" | "vite"): Promise<void> {
  const options = { cwd: project, electron: true };
  const input = path.join(project, "main.js");
  const output = { dir: path.join(project, "out"), format: "esm" as const };
  if (framework === "rollup") {
    watcher = rollupWatch({ input, external: [/^node:/], plugins: [rollupPlugin(options)], output });
  } else if (framework === "rolldown") {
    watcher = rolldownWatch({ input, platform: "node", plugins: [rolldownPlugin(options)], output });
  } else {
    watcher = (await viteBuild({
      configFile: false,
      root: project,
      logLevel: "silent",
      plugins: [vitePlugin(options)],
      build: { ssr: input, outDir: output.dir, watch: {}, rollupOptions: { output } },
    })) as Watcher;
  }
  await new Promise<void>((resolve, reject) => {
    watcher?.on("event", (event) => {
      if (event.code === "ERROR") reject(event.error);
      if (event.code === "BUNDLE_END") {
        // Closing a completed bundle must not close the watch session.
        Promise.resolve(event.result?.close()).then(resolve, reject);
      }
    });
  });
}

it.each(["rollup", "rolldown", "vite"] as const)(
  "%s closes the hot session and Electron with its watcher",
  async (framework) => {
    await start(framework);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.restartElectron).toHaveBeenCalledTimes(1));
    await watcher?.close();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.stopElectron).toHaveBeenCalledTimes(1);
    watcher = undefined;
  },
);

it("cancels an Electron launch scheduled just before the watcher closes", async () => {
  await start("rollup");
  await watcher?.close();
  watcher = undefined;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(mocks.restartElectron).not.toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  expect(mocks.stopElectron).toHaveBeenCalledTimes(1);
});
