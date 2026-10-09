import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Exercise the built CLI and real OS command lookup without registry installs. */
export function initSmoke(cli) {
  const version = JSON.parse(readFileSync(join(dirname(dirname(cli)), "package.json"), "utf8")).version;
  const temporary = mkdtempSync(join(tmpdir(), "electron-gpui-init-"));
  try {
    const bin = join(temporary, "bin");
    mkdirSync(bin);
    const recorder = join(bin, "record.cjs");
    writeFileSync(
      recorder,
      `const fs = require("node:fs");
fs.appendFileSync(process.env.ELECTRON_GPUI_INIT_LOG, JSON.stringify({ manager: process.argv[2], args: process.argv.slice(3), cwd: process.cwd() }) + "\\n");
if (process.env.ELECTRON_GPUI_INIT_FAIL) process.exit(1);
`,
    );
    for (const manager of ["pnpm", "npm", "yarn", "bun"]) {
      if (process.platform === "win32") {
        writeFileSync(join(bin, `${manager}.cmd`), `@"${process.execPath}" "${recorder}" ${manager} %*\r\n`);
      } else {
        writeFileSync(
          join(bin, manager),
          `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${recorder.replaceAll("'", "'\\''")}' ${manager} "$@"\n`,
          { mode: 0o755 },
        );
      }
    }
    for (const manager of ["pnpm", "npm", "yarn", "bun"]) {
      const project = join(temporary, `${manager} app #1's views`);
      mkdirSync(project);
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "test-app", packageManager: `${manager}@1.0.0` }),
      );
      const log = join(project, "install.log");
      const env = {
        ...process.env,
        [Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"]:
          `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? process.env.Path ?? ""}`,
        npm_config_user_agent: "npm/11.0.0",
        ELECTRON_GPUI_INIT_LOG: log,
      };
      const result = spawnSync(process.execPath, [cli, "init", "native"], {
        cwd: project,
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const commands = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(commands, [
        {
          manager,
          args: [manager === "npm" ? "install" : "add", "electron-gpui"],
          cwd: realpathSync(project),
        },
        {
          manager,
          args: [
            manager === "npm" ? "install" : "add",
            manager === "npm" ? "--save-dev" : "-D",
            "electron-gpui-unplugin",
          ],
          cwd: realpathSync(project),
        },
      ]);
      assert.ok(readFileSync(join(project, "native", "Cargo.toml"), "utf8").includes(`tag = "v${version}"`));
      assert.match(result.stdout, /configure the bundler plugin/);

      const skipped = spawnSync(process.execPath, [cli, "init", "skipped", "--skip-install"], {
        cwd: project,
        env,
        encoding: "utf8",
      });
      assert.equal(skipped.status, 0, skipped.stderr);
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);

      const failed = spawnSync(process.execPath, [cli, "init", "failed"], {
        cwd: project,
        env: { ...env, ELECTRON_GPUI_INIT_FAIL: "1" },
        encoding: "utf8",
      });
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /dependency installation failed/);
      assert.match(readFileSync(join(project, "failed", "src", "lib.rs"), "utf8"), /Hello/);
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
    }
    console.log("✓ CLI package-manager installs, skip-install and failure recovery");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
