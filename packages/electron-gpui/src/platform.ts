/** Find the views library in Cargo's artifact messages, including custom target directories. */
export function nativeArtifact(messages: string, targetName: string): string {
  for (const line of messages.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as {
      reason?: string;
      target?: { name: string; crate_types?: string[] };
      filenames?: string[];
    };
    if (
      message.reason !== "compiler-artifact" ||
      message.target?.name !== targetName ||
      !message.target.crate_types?.includes("cdylib")
    )
      continue;
    const library = message.filenames?.find((file) => /\.(dylib|dll|so)$/.test(file));
    if (library) return library;
  }
  throw new Error(`Cargo did not report a native library for ${targetName}`);
}

/** Linux's calloop must be driven on the same main thread as Electron. */
export function startEventPump(poll: () => void, hasWindows: () => boolean) {
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      poll();
    } catch (error) {
      stop();
      console.error("electron-gpui: stopped Linux event polling after a native error", error);
    }
  }, 8);
  const updateReference = (): void => {
    if (stopped) return;
    if (hasWindows()) timer.ref();
    else timer.unref();
  };
  updateReference();
  return { updateReference, stop };
}
