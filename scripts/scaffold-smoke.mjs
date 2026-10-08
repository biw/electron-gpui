import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".context/scaffold/native");
rmSync(directory, { recursive: true, force: true });
mkdirSync(join(root, ".context/scaffold"), { recursive: true });
const cli = join(root, "packages/electron-gpui/dist/cli.mjs");
execFileSync(process.execPath, [cli, "init", directory, "--local", root, "--name", "scaffold-native"], {
  stdio: "inherit",
});
execFileSync(process.execPath, [cli, "build", directory], {
  cwd: directory,
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: join(root, "target") },
});
