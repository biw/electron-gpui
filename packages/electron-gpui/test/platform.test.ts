import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { nativeArtifact, startEventPump } from "../src/platform.js";

afterEach(() => vi.restoreAllMocks());

describe("Cargo native artifacts", () => {
  it.each([
    "/custom/debug/libviews.dylib",
    "/custom/x86_64-unknown-linux-gnu/release/libviews.so",
    "C:\\target with spaces\\debug\\views.dll",
  ])("uses Cargo's actual output path: %s", (file) => {
    const messages = [
      {
        reason: "compiler-artifact",
        target: { name: "dependency", crate_types: ["rlib"] },
        filenames: ["dependency.rlib"],
      },
      {
        reason: "compiler-artifact",
        target: { name: "views", crate_types: ["cdylib"] },
        filenames: ["views.pdb", file],
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n");
    expect(nativeArtifact(messages, "views")).toBe(file);
    expect(() => nativeArtifact(messages, "missing")).toThrow(/did not report/);
  });
});

describe("Linux event pump", () => {
  it("keeps open windows alive, releases the loop on close, and stops on shutdown", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const poll = vi.fn();
    let windows = false;
    const pump = startEventPump(poll, () => windows);
    const timer = interval.mock.results[0]!.value as NodeJS.Timeout;
    try {
      expect(timer.hasRef()).toBe(false);
      windows = true;
      pump.updateReference();
      expect(timer.hasRef()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(poll).toHaveBeenCalled();
      windows = false;
      pump.updateReference();
      expect(timer.hasRef()).toBe(false);
      pump.stop();
      const calls = poll.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(poll).toHaveBeenCalledTimes(calls);
    } finally {
      pump.stop();
    }
  });
});
