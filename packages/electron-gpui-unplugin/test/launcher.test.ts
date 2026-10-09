import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ElectronLauncher } from "../src/launcher.js";

let project: string;
let log: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "electron-gpui-launcher-"));
  log = path.join(project, "launches.log");
  // Stands in for an Electron app: `node <project>` runs package.json's main.
  writeFileSync(path.join(project, "package.json"), '{ "main": "app.cjs" }');
  writeFileSync(
    path.join(project, "app.cjs"),
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.pid + " " + process.env.ELECTRON_GPUI_DEV + "\\n");
setInterval(() => {}, 1000);`,
  );
  writeFileSync(log, "");
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

const launches = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
}

describe("ElectronLauncher", () => {
  it("starts the app, then replaces it on restart", async () => {
    const launcher = new ElectronLauncher(project, {}, () => process.execPath);
    try {
      await launcher.restart();
      await waitFor(() => launches().length === 1);
      const [first] = launches();
      expect(first).toMatch(/ 1$/); // ELECTRON_GPUI_DEV=1

      await launcher.restart();
      await waitFor(() => launches().length === 2);
      const firstPid = Number(first?.split(" ")[0]);
      expect(() => process.kill(firstPid, 0)).toThrow(); // old process is gone

      await launcher.stop();
      expect(launcher.running).toBe(false);
    } finally {
      await launcher.stop();
    }
  });
});
