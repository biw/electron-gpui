#!/usr/bin/env node
// Fails when versions or toolchains that must move together have drifted.
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const problems = [];

const npmVersion = JSON.parse(read("packages/electron-gpui/package.json")).version;
const pluginVersion = JSON.parse(read("packages/electron-gpui-unplugin/package.json")).version;
const pluginPeer = JSON.parse(read("packages/electron-gpui-unplugin/package.json")).peerDependencies?.[
  "electron-gpui"
];
// npm publish doesn't rewrite `workspace:` ranges, so this must be a real range.
if (pluginPeer !== `^${npmVersion}`) {
  problems.push(
    `electron-gpui-unplugin's peerDependency on electron-gpui is ${pluginPeer}; expected ^${npmVersion}`,
  );
}
if (pluginVersion !== npmVersion) {
  problems.push(`electron-gpui-unplugin is ${pluginVersion} but electron-gpui is ${npmVersion}`);
}
const cargoVersion = read("Cargo.toml").match(/\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/)?.[1];
if (npmVersion !== cargoVersion) {
  problems.push(
    `npm package is ${npmVersion} but the Rust SDK is ${cargoVersion} (Cargo.toml [workspace.package])`,
  );
}

const channel = (path) => read(path).match(/channel\s*=\s*"([^"]+)"/)?.[1];
const toolchains = {
  "rust-toolchain.toml": channel("rust-toolchain.toml"),
  "packages/electron-gpui/templates/native/rust-toolchain.toml": channel(
    "packages/electron-gpui/templates/native/rust-toolchain.toml",
  ),
};
if (new Set(Object.values(toolchains)).size > 1) {
  problems.push(`Rust toolchains differ: ${JSON.stringify(toolchains)}`);
}

if (problems.length) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
console.log(
  `✓ versions (${npmVersion}) and toolchains (${toolchains["rust-toolchain.toml"]}) are consistent`,
);
