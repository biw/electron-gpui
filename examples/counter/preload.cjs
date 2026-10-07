const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  sendToGpui: (message) => ipcRenderer.send("send-to-gpui", message),
  onGpuiEvent: (callback) => ipcRenderer.on("gpui-event", (_e, event) => callback(event)),
});
