import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { classifyChange, typeDefinitions, typesChanged, writePatch } from "../src/hot.js";

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

describe("typeDefinitions", () => {
  it("finds structs (all forms) and enums with their bodies", () => {
    const definitions = typeDefinitions(view);
    expect([...definitions.keys()].sort()).toEqual([
      "enum Incoming",
      "struct Counter",
      "struct Pair",
      "struct Unit",
    ]);
    expect(definitions.get("struct Counter")).toContain("label: SharedString");
    expect(definitions.get("struct Pair")).toBe("struct Pair(u8, u16)");
  });
});

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
