// Types for the virtual module provided by electron-gpui-unplugin.
// Add `"types": ["electron-gpui-unplugin/client"]` to tsconfig.json, or
// `/// <reference types="electron-gpui-unplugin/client" />`.
declare module "virtual:electron-gpui/addon" {
  import type { GpuiAddon } from "electron-gpui";

  const addon: GpuiAddon;
  export default addon;
}
