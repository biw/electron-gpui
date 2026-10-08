import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const target = process.env.CARGO_TARGET_DIR ?? join(root, "target");
const stamp = join(target, ".last-sweep");
if (existsSync(target)) {
  if (spawnSync("cargo", ["sweep", "--version"], { stdio: "ignore" }).status !== 0) {
    console.log("[sweep] install cargo-sweep to clean old output (cargo install cargo-sweep)");
  } else if (
    process.argv.includes("--force") ||
    !existsSync(stamp) ||
    Date.now() - statSync(stamp).mtimeMs > 86_400_000
  ) {
    for (const args of [
      ["sweep", "--time", process.env.ELECTRON_GPUI_SWEEP_DAYS ?? "7"],
      ["sweep", "--installed"],
    ]) {
      const result = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
    writeFileSync(stamp, "");
  }
}
