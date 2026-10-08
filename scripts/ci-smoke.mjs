import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [display, command = "smoke"] = process.argv.slice(2);
const env = { ...process.env };
const services = [];
let runtime;
mkdirSync(".context", { recursive: true });
const start = (binary, args, name) => {
  const child = spawn(binary, args, {
    env,
    stdio: ["ignore", openSync(`.context/${name}.log`, "w"), "inherit"],
  });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  services.push(child);
  return child;
};
async function ready(test, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Display server exited ${child.exitCode}`);
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Display server did not become ready");
}
try {
  if (process.platform === "linux") {
    env.ELECTRON_GPUI_ELECTRON_ARGS = `--ozone-platform=${display} --no-sandbox`;
    if (display === "x11") {
      delete env.WAYLAND_DISPLAY;
      delete env.WAYLAND_SOCKET;
      env.DISPLAY = ":99";
      const server = start(
        "Xvfb",
        [":99", "-screen", "0", "1280x720x24", "+extension", "GLX", "+render", "-noreset"],
        "xvfb",
      );
      await ready(() => spawnSync("xdpyinfo", [], { env, stdio: "ignore" }).status === 0, server);
      start("openbox", [], "openbox");
    } else if (display === "wayland") {
      delete env.DISPLAY;
      delete env.WAYLAND_SOCKET;
      runtime = mkdtempSync(join(tmpdir(), "electron-gpui-wayland-"));
      env.XDG_RUNTIME_DIR = runtime;
      env.WAYLAND_DISPLAY = "wayland-electron-gpui";
      const server = start(
        "weston",
        [
          "--backend=headless-backend.so",
          "--renderer=pixman",
          `--socket=${env.WAYLAND_DISPLAY}`,
          "--idle-time=0",
          "--width=1280",
          "--height=720",
        ],
        "weston",
      );
      await ready(() => existsSync(join(runtime, env.WAYLAND_DISPLAY)), server);
    } else throw new Error(`Unknown Linux display ${display}`);
  }
  // npm_execpath avoids Windows .cmd shim spawning and shell quoting.
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error("Run ci-smoke through pnpm exec");
  const invocation = [process.execPath, pnpm, "--filter", "counter-example", command];
  const child =
    process.platform === "linux"
      ? spawn("dbus-run-session", ["--", ...invocation], { env, stdio: "inherit" })
      : spawn(invocation[0], invocation.slice(1), { env, stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
} finally {
  for (const child of services.reverse()) child.kill("SIGTERM");
  if (runtime) rmSync(runtime, { recursive: true, force: true });
}
