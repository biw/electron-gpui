import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ensureElectron } from "./ensure-electron.mjs";

export function viteBinary(project = process.cwd()) {
  const require = createRequire(join(project, "package.json"));
  // vite-plus does not export package.json; walk from its public entry point.
  const directory = dirname(dirname(require.resolve("vite-plus")));
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  return join(directory, metadata.bin.vp);
}

export function stopTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      const args = ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
      const killer = spawn("taskkill", args, { stdio: "ignore" });
      killer.on("error", () => child.kill());
    } else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

if (process.argv[1] === import.meta.filename) {
  const command = process.argv[2];
  const project = process.cwd();
  ensureElectron(project);
  const run = (binary, args, env = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: project,
        stdio: "inherit",
        detached: process.platform !== "win32",
        env: { ...process.env, NODE_ENV: "development", ...env },
      });
      const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
        const handler = () => stopTree(child, signal);
        process.once(signal, handler);
        return [signal, handler];
      });
      const cleanup = () => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("exit", (code, signal) => {
        cleanup();
        if (code === 0) resolve();
        else reject(new Error(`${binary} exited ${signal ?? code}`));
      });
    });
  if (command === "dev") await run(process.execPath, [viteBinary(project), "build", "--watch"]);
  else if (command === "hot") await run(process.execPath, [join(project, "hot-smoke.mjs")]);
  else {
    await run(process.execPath, [viteBinary(project), "build"]);
    const require = createRequire(join(project, "package.json"));
    const electron = require("electron");
    const args = [".", ...(process.env.ELECTRON_GPUI_ELECTRON_ARGS?.split(" ").filter(Boolean) ?? [])];
    const debuggerEnabled = process.env.ELECTRON_GPUI_SMOKE_DEBUGGER === "1";
    await run(
      debuggerEnabled ? "gdb" : electron,
      debuggerEnabled
        ? [
            "--batch",
            "--return-child-result",
            "-ex",
            "set print thread-events off",
            "-ex",
            "handle SIGPIPE nostop noprint pass",
            "-ex",
            "run",
            "-ex",
            "bt 30",
            "--args",
            electron,
            ...args,
          ]
        : args,
      command === "smoke" ? { ELECTRON_GPUI_SMOKE: "1" } : {},
    );
  }
}
