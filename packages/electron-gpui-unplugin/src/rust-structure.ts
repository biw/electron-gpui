interface Token {
  text: string;
}

const identifier = /^(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
const opening = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

/** Rust tokens with strings and characters kept opaque, and comments omitted. */
function tokens(source: string): Token[] {
  const result: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset);
    if (/^\s/u.test(rest)) {
      offset++;
      continue;
    }
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", offset);
      offset = end < 0 ? source.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      offset += 2;
      while (offset < source.length && depth > 0) {
        if (source.startsWith("/*", offset)) {
          depth++;
          offset += 2;
        } else if (source.startsWith("*/", offset)) {
          depth--;
          offset += 2;
        } else offset++;
      }
      continue;
    }
    const start = offset;
    const raw = /^(?:br|cr|r)(#*)"/.exec(rest);
    const quoted = /^(?:b|c)?"/.exec(rest);
    const character = /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(rest);
    if (raw) {
      const suffix = `"${raw[1]}`;
      const end = source.indexOf(suffix, offset + raw[0].length);
      offset = end < 0 ? source.length : end + suffix.length;
    } else if (quoted) {
      offset += quoted[0].length;
      while (offset < source.length) {
        const ch = source[offset++];
        if (ch === "\\") offset++;
        else if (ch === '"') break;
      }
    } else if (character) offset += character[0].length;
    else {
      const word = /^(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*/u.exec(rest);
      offset += word ? word[0].length : 1;
    }
    result.push({ text: source.slice(start, offset) });
  }
  return result;
}

function tokenAt(input: Token[], index: number): string {
  return input[index]?.text ?? "";
}

function groupEnd(input: Token[], start: number): number {
  const closing = opening.get(tokenAt(input, start));
  if (!closing) return start + 1;
  let cursor = start + 1;
  while (cursor < input.length) {
    if (tokenAt(input, cursor) === closing) return cursor + 1;
    cursor = opening.has(tokenAt(input, cursor)) ? groupEnd(input, cursor) : cursor + 1;
  }
  return input.length;
}

function itemEnd(input: Token[], start: number): number {
  const definition = /^(struct|enum|union)$/.test(tokenAt(input, start));
  let angles = 0;
  for (let cursor = start + 1; cursor < input.length; cursor++) {
    const text = tokenAt(input, cursor);
    if (text === "<") angles++;
    else if (text === ">" && tokenAt(input, cursor - 1) !== "-") angles = Math.max(0, angles - 1);
    if (text === ";" && angles === 0) return cursor + 1;
    if (opening.has(text)) {
      const end = groupEnd(input, cursor);
      if (definition && text === "{" && angles === 0) return end;
      cursor = end - 1;
    }
  }
  return input.length;
}

/** Local declarations can escape a function through its return value or heap. */
function localDefinitions(input: Token[]): string[] {
  const result: string[] = [];
  for (let cursor = 0; cursor < input.length; cursor++) {
    if (!/^(struct|enum|union|type|const|static)$/.test(tokenAt(input, cursor))) continue;
    const name = tokenAt(input, cursor + 1) === "mut" ? cursor + 2 : cursor + 1;
    if (!identifier.test(tokenAt(input, name))) continue;
    let start = cursor;
    if (tokenAt(input, start - 1) === "pub") start--;
    else if (tokenAt(input, start - 1) === ")") {
      let candidate = start - 2;
      while (candidate >= 0 && !(tokenAt(input, candidate) === "(" && groupEnd(input, candidate) === start))
        candidate--;
      if (tokenAt(input, candidate - 1) === "pub") start = candidate - 1;
    }
    // Include the attributes directly before the declaration (not its uses).
    while (tokenAt(input, start - 1) === "]") {
      let candidate = start - 2;
      while (candidate >= 0 && !(tokenAt(input, candidate) === "[" && groupEnd(input, candidate) === start))
        candidate--;
      if (tokenAt(input, candidate - 1) !== "#") break;
      start = candidate - 1;
    }
    const end = itemEnd(input, cursor);
    result.push(...input.slice(start, end).map((token) => token.text));
    cursor = end - 1;
  }
  return result;
}

/**
 * Everything affecting layouts, ABIs, or registrations, excluding ordinary
 * function bodies. Const functions remain structural because their results can
 * size arrays. Keeping macro definitions/invocations outside functions also
 * catches generated types and new initializer registrations.
 */
export function rustStructure(source: string): string {
  const input = tokens(source);
  const result: string[] = [];
  for (let cursor = 0; cursor < input.length; cursor++) {
    const token = tokenAt(input, cursor);
    result.push(token);
    if (tokenAt(input, cursor + 1) === "!") {
      const group =
        tokenAt(input, cursor + 2) === "{" ||
        tokenAt(input, cursor + 2) === "(" ||
        tokenAt(input, cursor + 2) === "["
          ? cursor + 2
          : cursor + 3;
      if (opening.has(tokenAt(input, group))) {
        const end = groupEnd(input, group);
        result.push(...input.slice(cursor + 1, end).map((token) => token.text));
        cursor = end - 1;
        continue;
      }
    }
    if (token !== "fn" || !identifier.test(tokenAt(input, cursor + 1))) continue;
    let prefix = cursor - 1;
    while (prefix >= 0 && ![";", "{", "}"].includes(tokenAt(input, prefix))) prefix--;
    if (input.slice(prefix + 1, cursor).some((token) => token.text === "const")) continue;
    let angles = 0;
    for (let header = cursor + 1; header < input.length; header++) {
      const text = tokenAt(input, header);
      if (text === "<") angles++;
      else if (text === ">" && tokenAt(input, header - 1) !== "-") angles = Math.max(0, angles - 1);
      if (text === ";" && angles === 0) break;
      if (!opening.has(text)) continue;
      const end = groupEnd(input, header);
      if (text === "{" && angles === 0) {
        result.push(...input.slice(cursor + 1, header + 1).map((token) => token.text));
        result.push(...localDefinitions(input.slice(header + 1, end - 1)), "}");
        cursor = end - 1;
        break;
      }
      header = end - 1;
    }
  }
  return JSON.stringify(result);
}
