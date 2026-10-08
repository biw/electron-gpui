import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { type HotAddon, hotConfigOf, startHotClient } from "./hot.js";
import { startEventPump } from "./platform.js";

/** Protocol version this package speaks. Must match the Rust SDK's `PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 1;

/** The functions `electron_gpui::export!` generates in your `.node` addon. */
export interface GpuiAddon {
  version(): string;
  protocolVersion(): number;
  init(): void;
  onEvent(callback: (eventJson: string) => void): void;
  openWindow(view: string, optionsJson?: string | null, propsJson?: string | null): number;
  send(windowId: number, messageJson: string): void;
  close(windowId: number): void;
  windowCount(): number;
  shutdown(): void;
  /** Internal Linux event dispatch; optional for older SDKs. */
  pollEvents?(): void;
  /** Present in addons built with SDK 0.2 or later. */
  setAlwaysOnTop?(windowId: number, onTop: boolean, relativeLevel?: number | null): void;
  setPanicLog?(path?: string | null): void;
  /** Present in addons built with the hot-reload-capable SDK. */
  hotAnchor?(): string;
  applyHotPatch?(jumpTableJson: string): void;
}

export interface WindowOptions {
  title?: string;
  /** Width in points. Defaults to 800. */
  width?: number;
  /** Height in points. Defaults to 600. */
  height?: number;
  /** Screen position in points; the window is centered when omitted. */
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  /** Defaults to true. */
  resizable?: boolean;
  /** Focus the window when it opens. Defaults to true. */
  focus?: boolean;
  /**
   * `"hidden"` extends the content under a transparent titlebar and hides the
   * title, keeping the traffic lights, like `BrowserWindow`'s `titleBarStyle:
   * "hidden"`. Applies on macOS; other platforms use native titlebars.
   * Defaults to `"default"`.
   */
  titleBarStyle?: "default" | "hidden";
  /** macOS traffic-light position in points, with `titleBarStyle: "hidden"`. */
  trafficLightPosition?: { x: number; y: number };
  /**
   * `"transparent"` and `"blurred"` show what's behind the window where the view
   * doesn't paint (`"blurred"` blurs it, like a vibrancy material). Defaults to
   * `"opaque"`. Blur falls back to transparency outside macOS; compositor
   * support determines whether transparency is available.
   */
  background?: "opaque" | "transparent" | "blurred";
  /** Open above normal windows; see {@link GpuiWindow.setAlwaysOnTop}. */
  alwaysOnTop?: boolean;
}

type NativeEvent =
  | { windowId: number; type: "event"; payload: unknown }
  | { windowId: number; type: "closed" };

interface WindowEvents<E> {
  event: [payload: E];
  closed: [];
}

/** A GPUI window opened with {@link Gpui.openWindow}. */
export class GpuiWindow<Message = unknown, Event = unknown> extends EventEmitter<WindowEvents<Event>> {
  #closed = false;

  constructor(
    private readonly gpui: Gpui,
    /** Native window id. */
    readonly id: number,
    /** Name of the registered root view. */
    readonly view: string,
  ) {
    super();
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** Send a JSON-serializable message to the view's `RootView::on_message`. */
  send(message: Message): void {
    this.#assertOpen();
    this.gpui.addon.send(this.id, JSON.stringify(message));
  }

  /**
   * Keep the window above normal windows, like `BrowserWindow`'s
   * `setAlwaysOnTop(flag, "floating", relativeLevel)`: `relativeLevel` raises it
   * that many levels above the floating level.
   */
  setAlwaysOnTop(flag: boolean, relativeLevel = 0): void {
    this.#assertOpen();
    const { addon } = this.gpui;
    if (!addon.setAlwaysOnTop) {
      throw new Error("electron-gpui: setAlwaysOnTop needs an addon built with Rust SDK 0.2 or later");
    }
    addon.setAlwaysOnTop(this.id, flag, relativeLevel);
  }

  /** Close the window. A `closed` event follows. */
  close(): void {
    if (this.#closed) return;
    this.gpui.addon.close(this.id);
  }

  /** @internal */
  _markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("closed");
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(`electron-gpui: window ${this.id} (${this.view}) is closed`);
    }
  }
}

interface GpuiEvents {
  "window-closed": [window: GpuiWindow];
  /** Emitted when the last open GPUI window closes. */
  "all-windows-closed": [];
}

/** Minimal slice of Electron's `app` that the runtime uses. */
export interface ElectronAppLike {
  on(event: "before-quit", listener: () => void): unknown;
}

export interface CreateGpuiOptions {
  /**
   * Electron's `app`. Defaults to `require("electron").app`. Used to shut GPUI
   * down on `before-quit`; pass `null` to manage shutdown yourself.
   */
  app?: ElectronAppLike | null;
  /**
   * File to append a JSON line to for every native panic: `{ time, message,
   * location, thread, aborts, backtrace }`. A panic while GPUI draws or handles
   * input can't be caught and aborts the process (`aborts: true`), before any JS
   * runs, so read this file on the next launch to report it.
   */
  panicLog?: string;
}

/** GPUI running inside this Electron main process. Create it with {@link createGpui}. */
export class Gpui extends EventEmitter<GpuiEvents> {
  readonly #windows = new Map<number, GpuiWindow>();
  #shutDown = false;
  #pump: ReturnType<typeof startEventPump> | undefined;
  #stopHot: (() => void) | undefined;

  /** @internal */
  constructor(
    readonly addon: GpuiAddon,
    panicLog?: string,
  ) {
    super();
    if (panicLog !== undefined) {
      if (!addon.setPanicLog) {
        throw new Error("electron-gpui: panicLog needs an addon built with Rust SDK 0.2 or later");
      }
      addon.setPanicLog(panicLog);
    }
    addon.init();
    addon.onEvent((json) => this.#dispatch(json));
    if (process.platform === "linux" && addon.pollEvents) {
      this.#pump = startEventPump(
        () => addon.pollEvents!(),
        () => this.#windows.size > 0,
      );
    }
  }

  /**
   * Open a window rendering the root view registered as `view` in your addon's
   * `export!` call. `props` is passed to `RootView::new` as JSON.
   */
  openWindow<Message = unknown, Event = unknown>(
    view: string,
    options: WindowOptions = {},
    props?: unknown,
  ): GpuiWindow<Message, Event> {
    if (this.#shutDown) throw new Error("electron-gpui: openWindow() called after shutdown()");
    const id = this.addon.openWindow(
      view,
      JSON.stringify(options),
      props === undefined ? null : JSON.stringify(props),
    );
    const window = new GpuiWindow<Message, Event>(this, id, view);
    this.#windows.set(id, window as GpuiWindow);
    this.#pump?.updateReference();
    return window;
  }

  /** Open GPUI windows. Electron's `window-all-closed` doesn't count these. */
  get windows(): GpuiWindow[] {
    return [...this.#windows.values()];
  }

  windowCount(): number {
    return this.#windows.size;
  }

  /** Close every GPUI window and stop event delivery. Called automatically on `before-quit`. */
  shutdown(): void {
    if (this.#shutDown) return;
    this.#shutDown = true;
    this.#pump?.stop();
    this.#stopHot?.();
    this.addon.shutdown();
    for (const window of this.#windows.values()) window._markClosed();
    this.#windows.clear();
  }

  #dispatch(json: string): void {
    let event: NativeEvent;
    try {
      event = JSON.parse(json) as NativeEvent;
    } catch (error) {
      console.error("electron-gpui: dropped malformed event from native addon", error);
      return;
    }
    const window = this.#windows.get(event.windowId);
    if (!window) return;

    if (event.type === "event") {
      window.emit("event", event.payload);
    } else if (event.type === "closed") {
      this.#windows.delete(event.windowId);
      this.#pump?.updateReference();
      window._markClosed();
      this.emit("window-closed", window);
      if (this.#windows.size === 0) this.emit("all-windows-closed");
    }
  }

  /** @internal */
  _attachHotClient(stop: () => void): void {
    this.#stopHot = stop;
  }
}

let current: Gpui | undefined;

/**
 * Start GPUI from your addon. Call once from Electron's main process, after
 * `app.whenReady()`. Repeated calls return the same instance.
 *
 * @param addon Your loaded addon (the `.node` file, `require`d), or its
 *   location as an absolute path or `file:` URL (in ES modules, a `URL` made
 *   relative to `import.meta.url`).
 */
export function createGpui(addon: GpuiAddon | string | URL, options: CreateGpuiOptions = {}): Gpui {
  if (current) return current;
  assertMainProcess();

  const loaded = typeof addon === "string" || addon instanceof URL ? loadAddon(addon) : addon;
  checkProtocol(loaded);

  const gpui = new Gpui(loaded, options.panicLog);
  const app = options.app === undefined ? defaultElectronApp() : options.app;
  app?.on("before-quit", () => gpui.shutdown());

  // Dev builds from electron-gpui-unplugin carry a hot-reload channel.
  const hot = hotConfigOf(loaded);
  if (hot && loaded.hotAnchor && loaded.applyHotPatch) {
    gpui._attachHotClient(startHotClient(loaded as GpuiAddon & HotAddon, hot));
  }
  current = gpui;
  return gpui;
}

/** Load a `.node` addon from an absolute path or a `file:` URL. */
export function loadAddon(location: string | URL): GpuiAddon {
  const path = location instanceof URL || location.startsWith("file:") ? fileURLToPath(location) : location;
  if (!isAbsolute(path)) {
    // A relative path would resolve against this package, not the caller.
    throw new Error(
      `electron-gpui: addon path must be absolute or a file: URL, got ${JSON.stringify(path)}. ` +
        "Resolve it against __dirname (path.join) or import.meta.url (new URL).",
    );
  }
  return createRequire(import.meta.url)(path) as GpuiAddon;
}

function checkProtocol(addon: GpuiAddon): void {
  if (typeof addon?.protocolVersion !== "function") {
    throw new Error(
      "electron-gpui: this doesn't look like an electron-gpui addon (no protocolVersion export). " +
        "Did you call electron_gpui::export! in your crate?",
    );
  }
  const native = addon.protocolVersion();
  if (native !== PROTOCOL_VERSION) {
    throw new Error(
      `electron-gpui: addon was built with Rust SDK ${addon.version()} (protocol ${native}), ` +
        `but this npm package speaks protocol ${PROTOCOL_VERSION}. Use matching versions of the ` +
        "electron-gpui npm package and Rust crate, then rebuild the addon.",
    );
  }
}

function assertMainProcess(): void {
  if (!isMainThread) throw new Error("electron-gpui: must be used on the main thread, not a worker");
  const type = (process as NodeJS.Process & { type?: string }).type;
  if (process.versions.electron && type !== "browser") {
    throw new Error(
      `electron-gpui: must be used from Electron's main process (current process type: ${type}).`,
    );
  }
}

function defaultElectronApp(): ElectronAppLike | null {
  if (!process.versions.electron) return null;
  const electron = createRequire(import.meta.url)("electron") as { app?: ElectronAppLike };
  return electron.app ?? null;
}

/** @internal Reset the singleton; for tests. */
export function _resetForTests(): void {
  current?.shutdown();
  current = undefined;
}
