import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

function managerOf(value: string | undefined): PackageManager | undefined {
  return value?.match(/^(pnpm|npm|yarn|bun)(?:@|\/|$)/)?.[1] as PackageManager | undefined;
}

/** Project declarations and lockfiles take precedence over `npx`'s npm user agent. */
export function detectPackageManager(
  cwd: string,
  userAgent = process.env.npm_config_user_agent,
): PackageManager {
  let directory = resolve(cwd);
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8")) as { packageManager?: string };
      const declared = managerOf(metadata.packageManager);
      if (declared) return declared;
    }
    const locks: [PackageManager, string[]][] = [
      ["pnpm", ["pnpm-lock.yaml", "pnpm-lock.yml"]],
      ["yarn", ["yarn.lock"]],
      ["bun", ["bun.lock", "bun.lockb"]],
      ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
    ];
    for (const [manager, files] of locks) {
      if (files.some((file) => existsSync(join(directory, file)))) return manager;
    }
    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, ".git"))) break;
    directory = parent;
  }
  return managerOf(userAgent) ?? "npm";
}

export function installDependencies(cwd: string): void {
  const manager = detectPackageManager(cwd);
  const workspace = manager === "pnpm" && existsSync(join(cwd, "pnpm-workspace.yaml"));
  const workspaceArgs = workspace ? ["--workspace-root"] : [];
  const commands =
    manager === "npm"
      ? [
          ["install", "electron-gpui"],
          ["install", "--save-dev", "electron-gpui-unplugin"],
        ]
      : [
          ["add", ...workspaceArgs, "electron-gpui"],
          ["add", ...workspaceArgs, "-D", "electron-gpui-unplugin"],
        ];
  for (const args of commands) {
    console.log(`electron-gpui: ${manager} ${args.join(" ")}`);
    // npm, pnpm and Yarn can be .cmd shims on Windows. All shell arguments here
    // are fixed package names and flags; project paths are passed through cwd.
    const result =
      process.platform === "win32"
        ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${manager} ${args.join(" ")}`], {
            cwd,
            stdio: "inherit",
          })
        : spawnSync(manager, args, { cwd, stdio: "inherit" });
    if (result.error) throw new Error(`could not run ${manager}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`${manager} ${args.join(" ")} failed (${result.signal ?? result.status ?? "unknown"})`);
    }
  }
}
