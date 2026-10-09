import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { detectPackageManager, installDependencies } from "../src/package-manager.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

let project: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "electron-gpui-manager-"));
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  rmSync(project, { recursive: true, force: true });
});

it("uses the declared package manager even when launched by npx", () => {
  writeFileSync(join(project, "package.json"), '{"packageManager":"pnpm@11.28.2"}');
  writeFileSync(join(project, "package-lock.json"), "{}");
  expect(detectPackageManager(project, "npm/11.0.0 node/v22.0.0")).toBe("pnpm");
});

it("finds a workspace's manager from a member package", () => {
  writeFileSync(join(project, "package.json"), '{"packageManager":"yarn@4.0.0"}');
  const member = join(project, "packages", "app");
  mkdirSync(member, { recursive: true });
  writeFileSync(join(member, "package.json"), '{"name":"app"}');
  expect(detectPackageManager(member, "npm/11.0.0")).toBe("yarn");
});

it.each([
  ["pnpm-lock.yaml", "pnpm"],
  ["pnpm-lock.yml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
])("detects %s before the launcher's user agent", (lockfile, manager) => {
  writeFileSync(join(project, lockfile), "");
  expect(detectPackageManager(project, "npm/11.0.0")).toBe(manager);
});

it("does not inherit a package manager from outside the repository", () => {
  writeFileSync(join(project, "package.json"), '{"packageManager":"pnpm@11.28.2"}');
  const nested = join(project, "other-repository");
  mkdirSync(join(nested, ".git"), { recursive: true });
  expect(detectPackageManager(nested, "bun/1.0.0")).toBe("bun");
});

it.each(["npm", "pnpm", "yarn", "bun"])("falls back to the %s user agent", (manager) => {
  mkdirSync(join(project, ".git"));
  expect(detectPackageManager(project, `${manager}/1.0.0`)).toBe(manager);
});

it("defaults to npm without project or launcher metadata", () => {
  mkdirSync(join(project, ".git"));
  expect(detectPackageManager(project, "")).toBe("npm");
});

it.each(["pnpm", "npm", "yarn", "bun"])("installs runtime and development packages with %s", (manager) => {
  writeFileSync(join(project, "package.json"), JSON.stringify({ packageManager: `${manager}@1.0.0` }));
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  installDependencies(project);
  expect(vi.mocked(spawnSync).mock.calls).toEqual([
    [manager, [manager === "npm" ? "install" : "add", "electron-gpui"], { cwd: project, stdio: "inherit" }],
    [
      manager,
      [
        manager === "npm" ? "install" : "add",
        manager === "npm" ? "--save-dev" : "-D",
        "electron-gpui-unplugin",
      ],
      { cwd: project, stdio: "inherit" },
    ],
  ]);
});

it("allows installs in an explicitly initialized pnpm workspace root", () => {
  writeFileSync(join(project, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(project, "package.json"), '{"packageManager":"pnpm@11.28.2"}');
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  installDependencies(project);
  expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toEqual(["add", "--workspace-root", "electron-gpui"]);
});

it("runs Windows command shims through cmd without interpolating project paths", () => {
  writeFileSync(join(project, "package.json"), '{"packageManager":"pnpm@11.28.2"}');
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  vi.stubEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe");
  installDependencies(project);
  expect(vi.mocked(spawnSync).mock.calls[0]).toEqual([
    "C:\\Windows\\System32\\cmd.exe",
    ["/d", "/s", "/c", "pnpm add electron-gpui"],
    { cwd: project, stdio: "inherit" },
  ]);
});

it("stops after a failed runtime install", () => {
  writeFileSync(join(project, "package.json"), '{"packageManager":"npm@11.0.0"}');
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 1,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 1,
    signal: null,
  });
  expect(() => installDependencies(project)).toThrow(/npm install electron-gpui failed/);
  expect(spawnSync).toHaveBeenCalledTimes(1);
});
