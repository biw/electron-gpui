#!/usr/bin/env node
// End-to-end hot reload test. Runs the real dev loop (`vp build --watch` with
// electron-gpui-unplugin launching the app), then edits the Rust views:
//   1. a code-only change must arrive in the running app (same process);
//   2. a struct change must restart the app (new process) with the new code.
//   3. a change in a local dependency crate (theme) must rebuild and restart.
// It also checks the patch doesn't run the crate's static initializers (the
// counter's GPUI action registrations) a second time.
// The source files are always restored.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stopTree, viteBinary } from "../../scripts/example.mjs";

const here = import.meta.dirname;
const source = join(here, "native/src/lib.rs");
const themeSource = join(here, "theme/src/lib.rs");
const manifestSource = join(here, "native/Cargo.toml");
const workspaceManifest = join(here, "../../Cargo.toml");
const originals = new Map(
  [source, themeSource, manifestSource, workspaceManifest].map((file) => [file, readFileSync(file, "utf8")]),
);
const status = join(tmpdir(), `electron-gpui-hot-smoke-${process.pid}.json`);
const appPids = new Set();
let output = "";
const deadline = (ms) => Date.now() + ms;

const dev = spawn(process.execPath, [viteBinary(here), "build", "--watch"], {
  cwd: here,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    NODE_ENV: "development",
    ELECTRON_GPUI_SMOKE: "hot",
    ELECTRON_GPUI_SMOKE_STATUS: status,
  },
});

for (const stream of [dev.stdout, dev.stderr]) {
  stream?.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-64 * 1024);
    process.stdout.write(chunk);
  });
}

function readStatus() {
  try {
    const value = JSON.parse(readFileSync(status, "utf8"));
    appPids.add(value.pid);
    return value;
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
  const next = transform(readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
  if (next === readFileSync(file, "utf8")) throw new Error(`edit didn't change ${file}`);
  writeFileSync(file, next);
}

const pong = (version) =>
  version
    ? `json!({ "type": "pong", "theme": counter_theme::NAME, "count": self.count, "v": ${version} })`
    : `json!({ "type": "pong", "theme": counter_theme::NAME, "count": self.count })`;
const frame = (version) =>
  version
    ? `json!({ "type": "frame", "count": self.count, "v": ${version} })`
    : `json!({ "type": "frame", "count": self.count })`;

let failed = false;
try {
  // First build compiles GPUI for the patchable build; allow time for it.
  const first = await waitFor(
    "the app to answer pings",
    (s) => s.pong.v === undefined && s.frame?.count === 7,
    20 * 60_000,
  );
  console.log(`[hot-smoke] app ${first.pid} is answering pings`);

  edit((s) => s.replace(pong(), pong(2)).replace(frame(), frame(2)));
  const hot = await waitFor(
    "the hot-patched message and render",
    (s) => s.pong.v === 2 && s.frame?.v === 2,
    120_000,
  );
  if (hot.pid !== first.pid)
    throw new Error(`expected a hot patch, but the app restarted (${first.pid} -> ${hot.pid})`);
  console.log(`[hot-smoke] code change hot-patched into ${hot.pid} without a restart`);
  if (hot.pong.count !== 7) throw new Error("hot patch lost the view's counter state");
  const checkInitializer = (pid) => {
    const file = `${status}.init-${pid}`;
    if (readFileSync(file, "utf8") !== "I") throw new Error("patch re-ran static initializers");
  };
  checkInitializer(hot.pid);
  edit((s) => s.replace(pong(2), pong(4)).replace(frame(2), frame(4)));
  const second = await waitFor(
    "a second hot patch",
    (s) => s.pong.v === 4 && s.frame?.v === 4 && s.frame.count === 7,
    120_000,
  );
  if (second.pid !== first.pid || second.pong.count !== 7)
    throw new Error("second patch restarted or lost state");
  checkInitializer(second.pid);
  edit((s) => s.replace(pong(4), 'compile_error!("hot smoke compile error"); ' + pong(4)));
  const stillRunning = await waitFor(
    "a compile error with the app still running",
    (s) => output.includes("hot smoke compile error") && s.pid === first.pid && s.pong.v === 4,
    120_000,
  );
  if (stillRunning?.pid !== first.pid || stillRunning.pong.v !== 4)
    throw new Error("compile error stopped the running app");
  edit((s) => s.replace('compile_error!("hot smoke compile error"); ', ""));
  console.log(
    "[hot-smoke] repeated patches preserve state and skip initializers; compile errors leave the app running",
  );

  edit((s) =>
    s
      .replace("    count: i64,\n", "    count: i64,\n    smoke_field: u8,\n")
      .replace(
        '            count: props["start"].as_i64().unwrap_or(0),\n',
        '            count: props["start"].as_i64().unwrap_or(0),\n            smoke_field: 0,\n',
      )
      .replace(pong(4), pong(3)),
  );
  const restarted = await waitFor("the restarted app's pong", (s) => s.pong.v === 3, 5 * 60_000);
  if (restarted.pid === hot.pid)
    throw new Error("expected a restart for a struct change, but the pid is unchanged");
  console.log(`[hot-smoke] struct change restarted the app (${hot.pid} -> ${restarted.pid})`);

  edit((s) => s.replace("struct Counter {", "#[repr(C)]\nstruct Counter {").replace(pong(3), pong(5)));
  const attributed = await waitFor("a layout-attribute restart", (s) => s.pong.v === 5, 5 * 60_000);
  if (attributed.pid === restarted.pid) throw new Error("layout attribute change did not restart the app");
  console.log(`[hot-smoke] layout attribute restarted the app (${restarted.pid} -> ${attributed.pid})`);

  edit((s) => s.replace('NAME: &str = "mocha"', 'NAME: &str = "latte"'), themeSource);
  const rebuilt = await waitFor("the theme change", (s) => s.pong.theme === "latte", 5 * 60_000);
  if (rebuilt.pid === attributed.pid) {
    throw new Error("expected a restart for a dependency change, but the pid is unchanged");
  }
  console.log(
    `[hot-smoke] dependency crate change rebuilt and restarted the app (${attributed.pid} -> ${rebuilt.pid})`,
  );
  // The rebuilt binary may be byte-identical. Windows must still be able to
  // emit/load it while the old process owns its loaded addon copy.
  edit((s) => s + "\n[package.metadata.electron-gpui-smoke]\nrestart = true\n", manifestSource);
  const configured = await waitFor(
    "a manifest-triggered restart",
    (s) => s.pid !== rebuilt.pid && s.pong.v === 5,
    5 * 60_000,
  );
  console.log(`[hot-smoke] manifest change restarted the app (${rebuilt.pid} -> ${configured.pid})`);
  edit((s) => s + "\n[workspace.metadata.electron-gpui-smoke]\nrestart = true\n", workspaceManifest);
  const workspaceConfigured = await waitFor(
    "a parent workspace manifest restart",
    (s) => s.pid !== configured.pid && s.pong.v === 5,
    5 * 60_000,
  );
  console.log(
    `[hot-smoke] workspace manifest restarted the app (${configured.pid} -> ${workspaceConfigured.pid})`,
  );
  console.log("[hot-smoke] PASS");
} catch (error) {
  failed = true;
  console.error(`[hot-smoke] FAIL: ${error.message}`);
} finally {
  for (const [file, contents] of originals) writeFileSync(file, contents);
  if (existsSync(status)) rmSync(status);
  for (const name of appPids) {
    if (name) rmSync(`${status}.init-${name}`, { force: true });
  }
  stopTree(dev, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  stopTree(dev, "SIGKILL");
}
process.exit(failed ? 1 : 0);
