interface Token {
  text: string;
  start: number;
  end: number;
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
    result.push({ text: source.slice(start, offset), start, end: offset });
  }
  return result;
}

function groupEnd(input: Token[], start: number): number {
  const closing = opening.get(input[start]?.text);
  if (!closing) return start + 1;
  let cursor = start + 1;
  while (cursor < input.length) {
    if (input[cursor].text === closing) return cursor + 1;
    cursor = opening.has(input[cursor].text) ? groupEnd(input, cursor) : cursor + 1;
  }
  return input.length;
}

function itemEnd(input: Token[], start: number): number {
  const definition = /^(struct|enum|union)$/.test(input[start].text);
  let angles = 0;
  for (let cursor = start + 1; cursor < input.length; cursor++) {
    const text = input[cursor].text;
    if (text === "<") angles++;
    else if (text === ">" && input[cursor - 1]?.text !== "-") angles = Math.max(0, angles - 1);
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
    if (!/^(struct|enum|union|type|const|static)$/.test(input[cursor].text)) continue;
    const name = input[cursor + 1]?.text === "mut" ? cursor + 2 : cursor + 1;
    if (!identifier.test(input[name]?.text ?? "")) continue;
    let start = cursor;
    if (input[start - 1]?.text === "pub") start--;
    else if (input[start - 1]?.text === ")") {
      let candidate = start - 2;
      while (candidate >= 0 && !(input[candidate].text === "(" && groupEnd(input, candidate) === start))
        candidate--;
      if (input[candidate - 1]?.text === "pub") start = candidate - 1;
    }
    // Include the attributes directly before the declaration (not its uses).
    while (input[start - 1]?.text === "]") {
      let candidate = start - 2;
      while (candidate >= 0 && !(input[candidate].text === "[" && groupEnd(input, candidate) === start))
        candidate--;
      if (input[candidate - 1]?.text !== "#") break;
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
    const token = input[cursor];
    result.push(token.text);
    if (input[cursor + 1]?.text === "!") {
      const group =
        input[cursor + 2]?.text === "{" || input[cursor + 2]?.text === "(" || input[cursor + 2]?.text === "["
          ? cursor + 2
          : cursor + 3;
      if (opening.has(input[group]?.text)) {
        const end = groupEnd(input, group);
        result.push(...input.slice(cursor + 1, end).map((token) => token.text));
        cursor = end - 1;
        continue;
      }
    }
    if (token.text !== "fn" || !identifier.test(input[cursor + 1]?.text ?? "")) continue;
    let prefix = cursor - 1;
    while (prefix >= 0 && ![";", "{", "}"].includes(input[prefix].text)) prefix--;
    if (input.slice(prefix + 1, cursor).some((token) => token.text === "const")) continue;
    let angles = 0;
    for (let header = cursor + 1; header < input.length; header++) {
      const text = input[header].text;
      if (text === "<") angles++;
      else if (text === ">" && input[header - 1]?.text !== "-") angles = Math.max(0, angles - 1);
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
