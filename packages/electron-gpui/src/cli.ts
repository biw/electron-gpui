#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { nativeArtifact } from "./platform.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = join(PACKAGE_ROOT, "templates", "native");
const VERSION = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string })
  .version;
const REPO = "https://github.com/biw/electron-gpui";
const MAC_TARGETS = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" } as const;

const USAGE = `electron-gpui ${VERSION}

Usage:
  electron-gpui init [dir] [--name <crate>] [--local <path>]
      Scaffold a Rust crate for your GPUI views (default dir: native).
      --local <path>  depend on a local checkout of the electron-gpui repo

  electron-gpui build [dir] [--release] [--universal] [--out <file>]
      Build the crate in dir (default: native) into a .node addon
      (default output: <dir>/index.node).
      --universal     build arm64 + x64 and combine them with lipo
`;

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      init(rest);
      return;
    case "build":
      build(rest);
      return;
    case "-v":
    case "--version":
      console.log(VERSION);
      return;
    case undefined:
    case "-h":
    case "--help":
      console.log(USAGE);
      return;
    default:
      fail(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
  }
}

function init(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { name: { type: "string" }, local: { type: "string" } },
  });
  const dir = resolve(positionals[0] ?? "native");
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    fail(`${relative(process.cwd(), dir) || "."} already exists and isn't empty`);
  }

  const name = toCrateName(values.name ?? `${basename(process.cwd())}-native`);
  let sdk: string;
  if (values.local) {
    const sdkPath = resolve(values.local, "crates", "electron-gpui");
    if (!existsSync(join(sdkPath, "Cargo.toml"))) {
      fail(`--local: ${sdkPath} doesn't contain the electron-gpui crate`);
    }
    sdk = `{ path = ${JSON.stringify(relative(dir, sdkPath))} }`;
  } else {
    sdk = `{ git = ${JSON.stringify(REPO)}, tag = "v${VERSION}" }`;
  }

  copyTemplate(TEMPLATE_DIR, dir, { name, sdk });
  const rel = relative(process.cwd(), dir) || ".";
  console.log(`Created ${rel}/ (crate ${name}).

Next, add the bundler plugin (pnpm add -D electron-gpui-unplugin):
  import electronGpui from "electron-gpui-unplugin/vite";
  export default defineConfig({ plugins: [electronGpui(${rel === "native" ? "" : `{ crate: ${JSON.stringify(rel)} }`})], ... });

and open a view from Electron's main process:
  import { createGpui } from "electron-gpui";
  import addon from "virtual:electron-gpui/addon";
  app.whenReady().then(() => createGpui(addon).openWindow("Hello", { title: "Hello" }));

Without a bundler: npx electron-gpui build ${rel}, then createGpui(new URL("./${rel}/index.node", import.meta.url)).`);
}

function copyTemplate(from: string, to: string, vars: Record<string, string>): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    // npm strips dotfiles named .gitignore, so templates store them as "_name";
    // `.tmpl` keeps tools (Cargo scanning a git checkout) from parsing templates.
    const name = (entry.startsWith("_") ? `.${entry.slice(1)}` : entry).replace(/\.tmpl$/, "");
    const target = join(to, name);
    if (statSync(source).isDirectory()) {
      copyTemplate(source, target, vars);
    } else {
      const text = readFileSync(source, "utf8").replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const value = vars[key];
        if (value === undefined) fail(`template ${source} uses unknown variable ${key}`);
        return value;
      });
      writeFileSync(target, text);
    }
  }
}

function toCrateName(name: string): string {
  const crate = name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!/^[a-z]/.test(crate)) fail(`can't derive a crate name from ${JSON.stringify(name)}; pass --name`);
  return crate;
}

interface CargoMetadata {
  target_directory: string;
  packages: { name: string; manifest_path: string; targets: { name: string; kind: string[] }[] }[];
}

function build(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      release: { type: "boolean", default: false },
      universal: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (!["darwin", "win32", "linux"].includes(process.platform))
    fail(`unsupported platform ${process.platform}`);
  if (values.universal && process.platform !== "darwin") fail("--universal is supported only on macOS");
  if (values.universal) run("rustup", ["target", "add", ...Object.values(MAC_TARGETS)]);

  const dir = resolve(positionals[0] ?? "native");
  const manifest = join(dir, "Cargo.toml");
  if (!existsSync(manifest)) fail(`no Cargo.toml in ${dir}; run \`electron-gpui init\` first`);

  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", manifest], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as CargoMetadata;
  const pkg = metadata.packages.find((p) => resolve(p.manifest_path) === manifest);
  const lib = pkg?.targets.find((t) => t.kind.includes("cdylib"));
  if (!pkg || !lib) fail(`${manifest} must define a [lib] with crate-type = ["cdylib"]`);

  // A host-only build skips --target so it shares target/<profile> with
  // `cargo build`, `cargo test` and clippy instead of duplicating every artifact.
  const targets: (string | undefined)[] = values.universal ? Object.values(MAC_TARGETS) : [undefined];

  const built = targets.map((target) => {
    const result = spawnSync(
      "cargo",
      [
        "build",
        "--message-format=json-render-diagnostics",
        "--manifest-path",
        manifest,
        "--lib",
        ...(target ? ["--target", target] : []),
        ...(values.release ? ["--release"] : []),
      ],
      { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) fail(`failed to run cargo: ${result.error.message}`);
    if (result.status !== 0) process.exit(result.status ?? 1);
    return nativeArtifact(result.stdout, lib.name);
  });

  const out = resolve(values.out ?? join(dir, "index.node"));
  mkdirSync(dirname(out), { recursive: true });
  // Write a new file and rename it over the old one. Overwriting in place breaks
  // macOS's code-signature cache for that file, and the next process to load it
  // is killed (SIGKILL) — e.g. when rebuilding while the app is running.
  const staging = `${out}.${process.pid}.tmp`;
  try {
    if (built.length > 1) {
      run("lipo", ["-create", ...built, "-output", staging]);
    } else {
      copyFileSync(built[0] as string, staging);
    }
    renameSync(staging, out);
  } finally {
    rmSync(staging, { force: true });
  }
  console.log(`electron-gpui: wrote ${relative(process.cwd(), out)}`);

  sweep(dir, metadata.target_directory);
}

/** Remove build output unused for a week, at most once a day (needs cargo-sweep). */
function sweep(dir: string, targetDir: string): void {
  if (process.env.ELECTRON_GPUI_NO_SWEEP) return;
  const stamp = join(targetDir, ".last-sweep");
  const day = 24 * 60 * 60 * 1000;
  if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < day) return;
  if (spawnSync("cargo", ["sweep", "--version"], { stdio: "ignore" }).status !== 0) {
    console.log(
      "electron-gpui: install cargo-sweep to clean old build output automatically (cargo install cargo-sweep)",
    );
    return;
  }
  const days = process.env.ELECTRON_GPUI_SWEEP_DAYS ?? "7";
  spawnSync("cargo", ["sweep", "--time", days], { cwd: dir, stdio: "ignore" });
  spawnSync("cargo", ["sweep", "--installed"], { cwd: dir, stdio: "ignore" });
  const now = new Date();
  if (existsSync(stamp)) utimesSync(stamp, now, now);
  else writeFileSync(stamp, "");
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) fail(`failed to run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message: string): never {
  console.error(`electron-gpui: ${message}`);
  process.exit(1);
}

main(process.argv.slice(2));
