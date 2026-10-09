import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initSmoke } from "./init-smoke.mjs";
const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".context/scaffold/native #1's views");
rmSync(directory, { recursive: true, force: true });
mkdirSync(join(root, ".context/scaffold"), { recursive: true });
const cli = join(root, "packages/electron-gpui/dist/cli.mjs");
initSmoke(cli);
const instructions = execFileSync(
  process.execPath,
  [cli, "init", directory, "--local", root, "--name", "scaffold-native", "--skip-install"],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);
console.log(instructions);
const addonUrl = instructions.match(/createGpui\(new URL\((.+), import\.meta\.url\)\)/)?.[1];
assert.ok(addonUrl, "scaffold instructions must include a standalone addon URL");
assert.equal(
  fileURLToPath(new URL(JSON.parse(addonUrl), pathToFileURL(join(root, "main.mjs")))),
  join(directory, "index.node"),
  "the printed JavaScript URL must resolve to the addon, including Windows separators and URL characters",
);
execFileSync(process.execPath, [cli, "build", directory], {
  cwd: directory,
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: join(root, "target") },
});
