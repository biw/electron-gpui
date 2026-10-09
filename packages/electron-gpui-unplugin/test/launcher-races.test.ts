import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ElectronLauncher } from "../src/launcher.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class FakeChild extends EventEmitter {
  pid = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);

  exit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

let children: FakeChild[];
let launcher: ElectronLauncher;

beforeEach(() => {
  children = [];
  launcher = new ElectronLauncher(process.cwd(), {}, () => "electron");
  vi.mocked(spawn).mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
});

afterEach(async () => {
  const stopping = launcher.stop();
  for (const child of children) child.exit();
  await stopping;
  vi.restoreAllMocks();
  vi.mocked(spawn).mockClear();
});

it("coalesces overlapping restarts and waits for the old process", async () => {
  await launcher.restart();
  const first = launcher.restart();
  const second = launcher.restart();
  await Promise.resolve();
  expect(children).toHaveLength(1);
  expect(children[0]?.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  children[0]?.exit();
  await Promise.all([first, second]);
  expect(children).toHaveLength(2);
  expect(launcher.running).toBe(true);
});

it("cancels a pending restart when stopped", async () => {
  await launcher.restart();
  const restarting = launcher.restart();
  let stopped = false;
  const stopping = launcher.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  children[0]?.exit();
  await Promise.all([restarting, stopping]);
  expect(children).toHaveLength(1);
  expect(launcher.running).toBe(false);
});

it("makes simultaneous stop callers wait for the process exit", async () => {
  await launcher.restart();
  const stopped: number[] = [];
  const first = launcher.stop().then(() => {
    stopped.push(1);
  });
  const second = launcher.stop().then(() => {
    stopped.push(2);
  });
  await Promise.resolve();
  expect(stopped).toEqual([]);
  children[0]?.exit();
  await Promise.all([first, second]);
  expect(stopped).toEqual([1, 2]);
  expect(children[0]?.kill).toHaveBeenCalledTimes(1);
});

it("reports an asynchronous spawn failure and can retry", async () => {
  const error = Object.assign(new Error("missing Electron"), { code: "ENOENT" });
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = new FakeChild();
    queueMicrotask(() => child.emit("error", error));
    return child as unknown as ChildProcess;
  });
  await expect(launcher.restart()).rejects.toBe(error);
  expect(launcher.running).toBe(false);
  await launcher.restart();
  expect(launcher.running).toBe(true);
});

it("keeps track of a live process when stopping fails", async () => {
  await launcher.restart();
  const error = new Error("kill failed");
  const stopping = launcher.stop();
  const rejected = expect(stopping).rejects.toBe(error);
  children[0]?.emit("error", error);
  await rejected;
  expect(launcher.running).toBe(true);
});
