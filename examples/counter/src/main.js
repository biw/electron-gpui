import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Built from ./native and bundled by electron-gpui-unplugin (see vite.config.js).
import addon from "virtual:electron-gpui/addon";
import { app, BrowserWindow, ipcMain } from "electron";
import { createGpui } from "electron-gpui";

// Resolved relative to the bundle in dist/.
const asset = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));

const SMOKE = Boolean(process.env.ELECTRON_GPUI_SMOKE);
const smokePanicLog = join(tmpdir(), `electron-gpui-smoke-panics-${process.pid}.jsonl`);

void app.whenReady().then(() => {
  const gpui = createGpui(addon, SMOKE ? { panicLog: smokePanicLog } : {});
  if (process.env.ELECTRON_GPUI_SMOKE === "hot") return runHotSmoke(gpui);
  if (SMOKE) return runSmokeTest(gpui);

  const page = new BrowserWindow({
    width: 520,
    height: 420,
    x: 80,
    y: 120,
    title: "Electron (web)",
    webPreferences: { preload: asset("preload.cjs") },
  });
  void page.loadFile(asset("index.html"));

  const counter = gpui.openWindow(
    "Counter",
    { title: "GPUI (native)", width: 520, height: 360 },
    { start: 0 },
  );

  // GPUI -> page
  counter.on("event", (event) => page.webContents.send("gpui-event", event));
  counter.on("closed", () => {
    if (!page.isDestroyed()) page.webContents.send("gpui-event", { type: "closed" });
  });

  // page -> GPUI
  ipcMain.on("send-to-gpui", (_event, text) => {
    if (!counter.isClosed) counter.send({ type: "setMessage", text });
  });
});

app.on("window-all-closed", () => {
  if (!SMOKE) app.quit();
});

/**
 * Exercise the JS <-> GPUI round trip without user input: open a window, ping
 * it, wait for the pong event, close it, and wait for the closed event.
 */
async function runSmokeTest(gpui) {
  const fail = (message) => {
    console.error(`[smoke] FAIL: ${message}`);
    app.exit(1);
  };
  setTimeout(() => fail("timed out after 30s"), 30_000).unref();

  try {
    const window = gpui.openWindow("Counter", { title: "smoke", width: 300, height: 200 });
    console.log(`[smoke] opened window ${window.id}`);

    const firstFrame = new Promise((resolve) =>
      window.on("event", (event) => event.type === "frame" && resolve()),
    );
    const page = new BrowserWindow({ width: 240, height: 180 });
    await page.loadURL(
      "data:text/html,<input id=entry><script>window.ticks=0;setInterval(()=>window.ticks++,10)</script>",
    );
    const pong = new Promise((resolve) => window.on("event", (event) => event.type === "pong" && resolve()));
    window.send({ type: "ping" });
    await pong;
    console.log("[smoke] received pong");
    await firstFrame;
    if ((await page.webContents.executeJavaScript("1 + 1")) !== 2)
      return fail("BrowserWindow stopped responding");
    console.log("[smoke] GPUI rendered and BrowserWindow remains responsive");

    window.send({ type: "setMessage", text: "hello from smoke test" });

    // A panic in on_message becomes a JS error, and the window keeps working.
    try {
      window.send({ type: "panic" });
      return fail("expected send({ type: 'panic' }) to throw");
    } catch (error) {
      if (!/on_message panicked/.test(error.message)) return fail(`unexpected error: ${error.message}`);
    }
    const pongAfterPanic = new Promise((resolve) =>
      window.on("event", (event) => event.type === "pong" && resolve()),
    );
    window.send({ type: "ping" });
    await pongAfterPanic;
    console.log("[smoke] on_message panic became a JS error; window still responds");

    const logged = existsSync(smokePanicLog)
      ? readFileSync(smokePanicLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    rmSync(smokePanicLog, { force: true });
    const entry = logged.find((panic) => panic.message === "requested by the smoke test");
    if (!entry) return fail(`the panic wasn't logged: ${JSON.stringify(logged)}`);
    if (entry.aborts) return fail("a caught on_message panic was logged as aborting");
    console.log("[smoke] panic logged to the panic log");

    // Window chrome options and runtime always-on-top.
    const styled = gpui.openWindow("Counter", {
      title: "smoke (styled)",
      width: 300,
      height: 200,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 16, y: 16 },
      background: "blurred",
      alwaysOnTop: true,
    });
    styled.setAlwaysOnTop(true, process.platform === "darwin" ? 2 : 0);
    styled.setAlwaysOnTop(false);
    const styledPong = new Promise((resolve) =>
      styled.on("event", (event) => event.type === "pong" && resolve()),
    );
    styled.send({ type: "ping" });
    await styledPong;
    const styledClosed = new Promise((resolve) => styled.once("closed", resolve));
    styled.close();
    await styledClosed;
    console.log("[smoke] window chrome options and setAlwaysOnTop work");

    const closed = new Promise((resolve) => window.once("closed", resolve));
    window.close();
    await closed;
    console.log("[smoke] window closed");

    if (gpui.windowCount() !== 0) return fail(`expected 0 windows, got ${gpui.windowCount()}`);
    gpui.shutdown();
    gpui.shutdown();
    if ((await page.webContents.executeJavaScript("1 + 1")) !== 2)
      return fail("GPUI shutdown stopped Electron's BrowserWindow");
    console.log("[smoke] idempotent shutdown leaves Electron responsive");
    page.close();
    console.log("[smoke] PASS");
    app.exit(0);
  } catch (error) {
    fail(error.stack ?? String(error));
  }
}

/**
 * For hot-smoke.mjs: ping the view continuously and record each pong (and this
 * process's pid) to $ELECTRON_GPUI_SMOKE_STATUS, so the driver can see code
 * changes arrive with or without a restart.
 */
function runHotSmoke(gpui) {
  const window = gpui.openWindow("Counter", { title: "hot smoke", width: 300, height: 200 });
  let frame;
  window.send({ type: "add", delta: 7 });
  window.on("event", (event) => {
    if (event.type === "frame") frame = event;
    if (event.type !== "pong") return;
    writeFileSync(
      process.env.ELECTRON_GPUI_SMOKE_STATUS,
      JSON.stringify({ pid: process.pid, pong: event, frame }),
    );
  });
  setInterval(() => window.send({ type: "ping" }), 100);
}
