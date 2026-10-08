# Contributing

Thanks for helping out! This is a pnpm + Cargo monorepo.

```
crates/electron-gpui/              Rust SDK (RootView, WindowBridge, export!)
crates/electron-gpui-hotpatch/     Hot-patch builder (adapted from the Dioxus CLI)
packages/electron-gpui/            npm package: JS runtime, CLI, scaffold templates
packages/electron-gpui-unplugin/   Bundler plugin that builds and bundles the addon
examples/counter/                  Example Electron app (Vite-bundled main process) and its views crate
scripts/                           Cargo cleanup, Electron install fix, consistency checks
```

## Setup

You need macOS (ARM64 or Intel), Windows x64 with MSVC Build Tools and the Windows SDK, or Linux x64 with GNU/glibc. Install [rustup](https://rustup.rs), Node 22+ and pnpm (the version in `package.json`'s `packageManager`; `corepack enable` picks it up). Linux build dependencies are listed in [.github/actions/setup/action.yml](.github/actions/setup/action.yml).

```sh
pnpm install
pnpm dev          # fetch the pinned GPUI fork, build everything, run the counter example
```

Recommended tools:

```sh
cargo install cargo-sweep   # automatic cleanup of old build output (see below)
cargo install cargo-deny    # license/source checks run in CI
```

## Everyday commands

| Command                             |                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Build and launch the counter example                                                                                                                    |
| `pnpm smoke`                        | Automated round-trip test of the counter example through Vite and the plugin (what CI runs)                                                             |
| `pnpm smoke:hot`                    | End-to-end hot reload test: edits the counter's Rust code while it runs and checks it's hot-patched (no restart), then that a struct change restarts it |
| `pnpm test`                         | JS unit tests (including real Vite/Rollup/Rolldown/webpack/esbuild builds of the plugin) and Rust tests                                                 |
| `pnpm lint` / `pnpm format`         | Vite+ (`vp check`: format, lint, type check), rustfmt, clippy                                                                                           |
| `cargo deny check licenses sources` | Dependency license policy (`deny.toml`)                                                                                                                 |
| `pnpm clean:cargo`                  | Remove Cargo output unused for 7 days, now                                                                                                              |

### Keeping `target/` small

GPUI is big, so `target/` grows quickly. Every addon build (`electron-gpui build`, which the bundler plugin, `pnpm dev` and `pnpm smoke` use) runs [cargo-sweep](https://github.com/holmgr/cargo-sweep) at most once a day, removing output unused for 7 days and output from uninstalled toolchains. Change the window with `ELECTRON_GPUI_SWEEP_DAYS`, skip it with `ELECTRON_GPUI_NO_SWEEP=1`, or run it immediately with `pnpm clean:cargo`. Without cargo-sweep installed, builds print a hint and carry on.

## GPUI and the Zed fork

GPUI comes from [`biw/zed`](https://github.com/biw/zed), branch `electron-gpui-embedded-cross-platform`, based on the previous embedded macOS revision:

- `MacPlatform::new_embedded()`, so GPUI runs inside Electron's `NSApp` instead of owning it.
- Blurred window backgrounds that work on macOS 27 (submitted upstream as [zed-industries/zed#65361](https://github.com/zed-industries/zed/pull/65361); drop it once Zed has it).
- Embedded Windows initialization, a GPUI-only message hook, no process-wide quit messages, and WARP fallback.
- Embedded Linux initialization and nonblocking X11/Wayland event dispatch.
- Portable always-on-top support for Windows and X11, with a default no-op on unsupported backends.

`Cargo.toml` pins it by `rev`.

To move to a newer Zed:

1. In a clone of `biw/zed`, put the embedded changes onto the Zed commit you want, fix any conflicts, and publish a new branch while preserving old revisions.
2. Update all four GPUI `rev`s in `Cargo.toml` (`[workspace.dependencies]`) together, and run `cargo update -p gpui`.
3. Match the Rust toolchain to the fork's `rust-toolchain.toml` in `rust-toolchain.toml` and `packages/electron-gpui/templates/native/rust-toolchain.toml` (`node scripts/check-consistency.mjs` checks the two of ours agree).
4. `pnpm lint && pnpm test && pnpm smoke && pnpm smoke:hot`.

Old revisions must stay reachable on the fork (apps pin SDK tags that reference them), so rebase onto a new branch name or keep old heads tagged rather than force-pushing over them.

CI checks `macos-15` (ARM64), `macos-15-intel`, `windows-2025`, and `ubuntu-24.04`. Electron 30 and latest run native window smoke tests; latest also runs state-preserving repeated hot patches, initializer suppression, compile-error recovery and structural/dependency restarts. Linux runs both Xvfb/Openbox and headless Weston with software graphics. To run the Linux harness locally: `pnpm exec node scripts/ci-smoke.mjs x11 smoke` (or `wayland`, and `smoke:hot`). PR, manual and reusable CI all use the complete matrix, and release publishing waits for it.

## Releasing

Both npm packages and the Rust SDK share one version (`node scripts/check-consistency.mjs` checks it, including the plugin's peer range on `electron-gpui`).

1. Add a changeset in your PR (`pnpm changeset`) for user-facing changes.
2. To release, open a PR that runs `pnpm changeset version` and sets the same version in `Cargo.toml` (`[workspace.package]`) and in the plugin's `peerDependencies` (`^X.Y.Z`).
3. Merging it into `main` is the release. `.github/workflows/release.yml` uses [npm-trusted-publish-workflows](https://github.com/biw/npm-trusted-publish-workflows): for each package whose version isn't on npm yet, it runs CI on that commit, publishes with provenance through npm trusted publishing (no tokens), and creates the `vX.Y.Z` GitHub release and tag.

Apps pin the Rust SDK to that `vX.Y.Z` git tag, so tags are permanent.

Publishing is off until the repo is public (npm provenance requires it). To turn it on, set the repository variable `NPM_PUBLISH_ENABLED=true` and, on npmjs.com, add a trusted publisher to both packages with this repository and the workflow file `release.yml`.

## Pull requests

- Keep changes focused, and add tests for behavior changes (`packages/*/test`, Rust unit tests, or the smoke test for cross-boundary behavior).
- `pnpm lint && pnpm test && pnpm smoke` should pass.
