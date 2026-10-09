import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { classifyChange, typesChanged, writePatch } from "../src/hot.js";

const view = `
use gpui::*;

#[derive(Clone)]
struct Counter {
    count: i64,
    label: SharedString,
}

enum Incoming { SetMessage { text: String }, Ping }

struct Unit;
struct Pair(u8, u16);

impl Counter {
    fn change(&mut self, delta: i64) {
        self.count += delta;
    }
}
`;

describe("typesChanged", () => {
  it("ignores changes to function bodies and formatting", () => {
    const edited = view.replace("self.count += delta;", "self.count += delta * 2;");
    expect(typesChanged(view, edited)).toBe(false);
    expect(typesChanged(view, view.replace("count: i64,", "count:   i64,"))).toBe(false);
  });

  it("detects field, variant and type additions or removals", () => {
    expect(typesChanged(view, view.replace("count: i64,", "count: i64,\n    extra: bool,"))).toBe(true);
    expect(typesChanged(view, view.replace("Ping }", "Ping, Pong }"))).toBe(true);
    expect(typesChanged(view, `${view}\nstruct Added { x: u8 }`)).toBe(true);
    expect(typesChanged(view, view.replace("struct Unit;", ""))).toBe(true);
  });

  it.each([
    ["#[repr(C)] struct State { x: u64 }", "#[repr(packed)] struct State { x: u64 }"],
    ["type Count = i64; struct State { x: Count }", "type Count = i32; struct State { x: Count }"],
    ["const SIZE: usize = 4; struct State([u8; SIZE]);", "const SIZE: usize = 8; struct State([u8; SIZE]);"],
    ["const fn size() -> usize { 4 }", "const fn size() -> usize { 8 }"],
    ["fn value(x: i64) -> i64 { x }", "fn value(x: i32) -> i32 { x }"],
    ["actions!(example, [First]);", "actions!(example, [First, Second]);"],
    ["macro_rules! view { () => { fn value() { 1 } } }", "macro_rules! view { () => { fn value() { 2 } } }"],
    ["fn value() { #[repr(C)] struct Local(u64); }", "fn value() { #[repr(packed)] struct Local(u64); }"],
    ["fn value() { type Local = [u8; 4]; }", "fn value() { type Local = [u8; 8]; }"],
  ])("restarts for structural Rust items: %s", (previous, next) => {
    expect(typesChanged(previous, next)).toBe(true);
  });

  it("ignores opaque strings, characters, nested comments, lifetimes and body macros", () => {
    const before = `
      /* outer /* struct Fake; */ comment */
      struct State<'a> { text: &'a str }
      impl<'a> State<'a> {
        fn value<const N: usize>(&self) -> [u8; N] {
          let text = r###"} struct Fake; /* fn fake() { */"###;
          let brace = '}'; let quote = '\\''; let unicode = '\\u{1f600}';
          json!({ "struct": "enum Fake {" });
          [1; N]
        }
      }
    `;
    expect(typesChanged(before, before.replace("[1; N]", "[2; N]"))).toBe(false);
    expect(typesChanged(before, before.replace("enum Fake {", "union Changed {"))).toBe(false);
    expect(typesChanged(before, before.replace("outer", "edited"))).toBe(false);
    expect(typesChanged(before, before.replace("text: &'a str", "text : & 'a str"))).toBe(false);
  });

  it("keeps unchanged local layouts patchable while restarting for changed local constants", () => {
    const before = "fn value() { const N: usize = 4; struct Local([u8; N]); use_value(1); }";
    expect(typesChanged(before, before.replace("use_value(1)", "use_value(2)"))).toBe(false);
    expect(typesChanged(before, before.replace("usize = 4", "usize = 8"))).toBe(true);
  });
});

describe("classifyChange", () => {
  const crate = path.resolve("/app/native");
  const lib = path.join(crate, "src/lib.rs");

  it("hot-patches code-only edits", () => {
    expect(classifyChange(crate, lib, view, view.replace("delta;", "delta + 1;"))).toBe("hot");
  });

  it("restarts for type changes, new or deleted files, and build configuration", () => {
    expect(classifyChange(crate, lib, view, view.replace("count: i64", "count: i32"))).toBe("full");
    expect(classifyChange(crate, path.join(crate, "src/new.rs"), undefined, "fn x() {}")).toBe("full");
    expect(classifyChange(crate, lib, view, undefined)).toBe("full");
    expect(classifyChange(crate, path.join(crate, "Cargo.toml"), "a", "b")).toBe("full");
    expect(classifyChange(crate, path.join(crate, "build.rs"), "a", "b")).toBe("full");
  });
});

describe("writePatch", () => {
  it("records which app process the jump table was built for", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "electron-gpui-patch-"));
    try {
      const file = path.join(dir, "pending.json.tmp");
      writeFileSync(file, '{"map":{"1":2},"aslr_reference":0}');
      writePatch(file, { pid: 42, anchor: "0xabc" });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        target: { pid: 42, anchor: "0xabc" },
        table: { map: { "1": 2 }, aslr_reference: 0 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
