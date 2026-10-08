import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function ensureElectron(project = process.cwd()) {
  const require = createRequire(join(project, "package.json"));
  const directory = dirname(require.resolve("electron/package.json"));
  const framework = join(directory, "dist/Electron.app/Contents/Frameworks/Electron Framework.framework");
  if (process.platform !== "darwin") {
    try {
      if (existsSync(require("electron"))) return;
    } catch {}
    execFileSync(process.execPath, [join(directory, "install.js")], { stdio: "inherit" });
    return;
  }
  if (existsSync(framework)) return;
  const version = require("electron/package.json").version;
  const zipName = `electron-v${version}-darwin-${process.arch}.zip`;
  const cache = process.env.electron_config_cache ?? join(homedir(), "Library/Caches/electron");
  const findZip = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.name === zipName) return file;
      if (entry.isDirectory()) {
        const found = findZip(file);
        if (found) return found;
      }
    }
  };
  let zip = findZip(cache);
  if (!zip) {
    rmSync(join(directory, "dist"), { recursive: true, force: true });
    execFileSync(process.execPath, [join(directory, "install.js")], { stdio: "inherit" });
    if (existsSync(framework)) return;
    zip = findZip(cache);
  }
  if (!zip) throw new Error(`Could not find ${zipName} to repair Electron`);
  console.log(`[electron] Re-extracting ${zipName} with ditto`);
  rmSync(join(directory, "dist"), { recursive: true, force: true });
  mkdirSync(join(directory, "dist"), { recursive: true });
  execFileSync("ditto", ["-x", "-k", zip, join(directory, "dist")]);
  writeFileSync(join(directory, "path.txt"), "Electron.app/Contents/MacOS/Electron");
}
