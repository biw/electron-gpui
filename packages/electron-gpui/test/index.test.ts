import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { _resetForTests, createGpui, type GpuiAddon, PROTOCOL_VERSION } from "../src/index.js";

function fakeAddon(overrides: Partial<GpuiAddon> = {}) {
  let emit: (json: string) => void = () => {};
  let nextId = 1;
  const addon = {
    version: () => "0.1.0",
    protocolVersion: () => PROTOCOL_VERSION,
    init: vi.fn(),
    onEvent: vi.fn((callback: (json: string) => void) => {
      emit = callback;
    }),
    openWindow: vi.fn(() => nextId++),
    send: vi.fn(),
    close: vi.fn(),
    windowCount: () => 0,
    shutdown: vi.fn(),
    ...overrides,
  } satisfies GpuiAddon;
  return {
    addon,
    emit: (event: unknown) => emit(JSON.stringify(event)),
    emitRaw: (json: string) => emit(json),
  };
}

afterEach(() => _resetForTests());

describe("createGpui", () => {
  it("initializes the addon once and returns a singleton", () => {
    const { addon } = fakeAddon();
    const gpui = createGpui(addon, { app: null });
    expect(createGpui(addon, { app: null })).toBe(gpui);
    expect(addon.init).toHaveBeenCalledTimes(1);
  });

  it("rejects addons built for another protocol version", () => {
    const { addon } = fakeAddon({ protocolVersion: () => PROTOCOL_VERSION + 1 });
    expect(() => createGpui(addon, { app: null })).toThrow(/protocol/);
  });

  it("rejects relative addon paths, which would resolve against this package", () => {
    expect(() => createGpui("./native/index.node", { app: null })).toThrow(/absolute or a file: URL/);
  });

  it("rejects objects that aren't electron-gpui addons", () => {
    expect(() => createGpui({} as GpuiAddon, { app: null })).toThrow(/export!/);
  });

  it("sets the panic log before initializing", () => {
    const calls: string[] = [];
    const { addon } = fakeAddon({
      setPanicLog: vi.fn(() => calls.push("setPanicLog")),
      init: vi.fn(() => calls.push("init")),
    });
    createGpui(addon, { app: null, panicLog: "/tmp/panics.jsonl" });
    expect(addon.setPanicLog).toHaveBeenCalledWith("/tmp/panics.jsonl");
    expect(calls).toEqual(["setPanicLog", "init"]);
  });

  it("explains that panicLog needs a newer addon", () => {
    const { addon } = fakeAddon();
    expect(() => createGpui(addon, { app: null, panicLog: "/tmp/p" })).toThrow(/SDK 0\.2/);
  });

  it("shuts down on before-quit", () => {
    const { addon } = fakeAddon();
    let beforeQuit = () => {};
    createGpui(addon, { app: { on: (_event, listener) => (beforeQuit = listener) } });
    beforeQuit();
    expect(addon.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("GpuiWindow", () => {
  it("serializes options, props and messages as JSON", () => {
    const { addon } = fakeAddon();
    const window = createGpui(addon, { app: null }).openWindow("Counter", { title: "t" }, { start: 3 });
    expect(addon.openWindow).toHaveBeenCalledWith("Counter", '{"title":"t"}', '{"start":3}');
    window.send({ type: "ping" });
    expect(addon.send).toHaveBeenCalledWith(window.id, '{"type":"ping"}');
  });

  it("passes window chrome options through and sets always-on-top", () => {
    const setAlwaysOnTop = vi.fn();
    const { addon } = fakeAddon({ setAlwaysOnTop });
    const options = {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 20, y: 16 },
      background: "blurred",
      alwaysOnTop: true,
    } as const;
    const window = createGpui(addon, { app: null }).openWindow("Settings", options);
    expect(addon.openWindow).toHaveBeenCalledWith("Settings", JSON.stringify(options), null);
    window.setAlwaysOnTop(true, 2);
    window.setAlwaysOnTop(false);
    expect(setAlwaysOnTop.mock.calls).toEqual([
      [window.id, true, 2],
      [window.id, false, 0],
    ]);
  });

  it("explains that setAlwaysOnTop needs a newer addon", () => {
    const { addon } = fakeAddon();
    const window = createGpui(addon, { app: null }).openWindow("A");
    expect(() => window.setAlwaysOnTop(true)).toThrow(/SDK 0\.2/);
  });

  it("routes events to the right window", () => {
    const { addon, emit } = fakeAddon();
    const gpui = createGpui(addon, { app: null });
    const a = gpui.openWindow("A");
    const b = gpui.openWindow("B");
    const onA = vi.fn();
    const onB = vi.fn();
    a.on("event", onA);
    b.on("event", onB);
    emit({ windowId: b.id, type: "event", payload: { n: 1 } });
    expect(onA).not.toHaveBeenCalled();
    expect(onB).toHaveBeenCalledWith({ n: 1 });
  });

  it("tracks closed windows", () => {
    const { addon, emit } = fakeAddon();
    const gpui = createGpui(addon, { app: null });
    const window = gpui.openWindow("A");
    const onClosed = vi.fn();
    const onAllClosed = vi.fn();
    window.on("closed", onClosed);
    gpui.on("all-windows-closed", onAllClosed);

    emit({ windowId: window.id, type: "closed" });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onAllClosed).toHaveBeenCalledTimes(1);
    expect(window.isClosed).toBe(true);
    expect(gpui.windowCount()).toBe(0);
    expect(() => window.send("late")).toThrow(/closed/);
  });

  it("ignores malformed native events", () => {
    const { addon, emitRaw } = fakeAddon();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    createGpui(addon, { app: null });
    emitRaw("not json");
    expect(error).toHaveBeenCalled();
  });
});
