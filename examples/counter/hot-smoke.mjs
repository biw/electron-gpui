#!/usr/bin/env node
// End-to-end hot reload test. Runs the real dev loop (`vp build --watch` with
// electron-gpui-unplugin launching the app), then edits the Rust views:
//   1. a code-only change must arrive in the running app (same process);
//   2. a struct change must restart the app (new process) with the new code.
//   3. a change in a local dependency crate (theme) must rebuild and restart.
// The source files are always restored.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const source = join(here, "native/src/lib.rs");
const themeSource = join(here, "theme/src/lib.rs");
const originals = new Map([source, themeSource].map((file) => [file, readFileSync(file, "utf8")]));
const status = join(tmpdir(), `electron-gpui-hot-smoke-${process.pid}.json`);
const deadline = (ms) => Date.now() + ms;

const dev = spawn(join(here, "node_modules/.bin/vp"), ["build", "--watch"], {
  cwd: here,
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
  env: {
    ...process.env,
    NODE_ENV: "development",
    ELECTRON_GPUI_SMOKE: "hot",
    ELECTRON_GPUI_SMOKE_STATUS: status,
  },
});

function readStatus() {
  try {
    return JSON.parse(readFileSync(status, "utf8"));
  } catch {
    return undefined;
  }
}

async function waitFor(description, predicate, ms) {
  const until = deadline(ms);
  while (Date.now() < until) {
    const current = readStatus();
    if (current && predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${description}; last status: ${JSON.stringify(readStatus())}`);
}

function edit(transform, file = source) {
  const next = transform(readFileSync(file, "utf8"));
  if (next === readFileSync(file, "utf8")) throw new Error(`edit didn't change ${file}`);
  writeFileSync(file, next);
}

const pong = (version) =>
  version
    ? `json!({ "type": "pong", "theme": counter_theme::NAME, "v": ${version} })`
    : `json!({ "type": "pong", "theme": counter_theme::NAME })`;

let failed = false;
try {
  // First build compiles GPUI for the patchable build; allow time for it.
  const first = await waitFor("the app to answer pings", (s) => s.pong.v === undefined, 10 * 60_000);
  console.log(`[hot-smoke] app ${first.pid} is answering pings`);

  edit((s) => s.replace(pong(), pong(2)));
  const hot = await waitFor("the hot-patched pong", (s) => s.pong.v === 2, 120_000);
  if (hot.pid !== first.pid)
    throw new Error(`expected a hot patch, but the app restarted (${first.pid} -> ${hot.pid})`);
  console.log(`[hot-smoke] code change hot-patched into ${hot.pid} without a restart`);

  edit((s) =>
    s
      .replace("    count: i64,\n", "    count: i64,\n    smoke_field: u8,\n")
      .replace(
        '            count: props["start"].as_i64().unwrap_or(0),\n',
        '            count: props["start"].as_i64().unwrap_or(0),\n            smoke_field: 0,\n',
      )
      .replace(pong(2), pong(3)),
  );
  const restarted = await waitFor("the restarted app's pong", (s) => s.pong.v === 3, 5 * 60_000);
  if (restarted.pid === hot.pid)
    throw new Error("expected a restart for a struct change, but the pid is unchanged");
  console.log(`[hot-smoke] struct change restarted the app (${hot.pid} -> ${restarted.pid})`);

  edit((s) => s.replace('NAME: &str = "mocha"', 'NAME: &str = "latte"'), themeSource);
  const rebuilt = await waitFor("the theme change", (s) => s.pong.theme === "latte", 5 * 60_000);
  if (rebuilt.pid === restarted.pid) {
    throw new Error("expected a restart for a dependency change, but the pid is unchanged");
  }
  console.log(
    `[hot-smoke] dependency crate change rebuilt and restarted the app (${restarted.pid} -> ${rebuilt.pid})`,
  );
  console.log("[hot-smoke] PASS");
} catch (error) {
  failed = true;
  console.error(`[hot-smoke] FAIL: ${error.message}`);
} finally {
  for (const [file, contents] of originals) writeFileSync(file, contents);
  if (existsSync(status)) rmSync(status);
  // Stop vite and the app it launched (same process group).
  const kill = (signal) => {
    try {
      if (dev.pid) process.kill(-dev.pid, signal);
    } catch {
      // Already exited.
    }
  };
  kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  kill("SIGKILL");
}
process.exit(failed ? 1 : 0);
