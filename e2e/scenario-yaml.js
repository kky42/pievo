function stripCommentLine(line) {
  return /^\s*#/.test(line) ? "" : line.replace(/\s+$/, "");
}

function countIndent(line) {
  const match = /^( *)/.exec(line);
  return match ? match[1].length : 0;
}

function parseScalar(value) {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    if (text.startsWith('"')) {
      return JSON.parse(text);
    }
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  return text;
}

function splitKeyValue(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ":") {
      const key = text.slice(0, index).trim();
      const value = text.slice(index + 1).trim();
      if (!key) return null;
      return { key, value };
    }
  }
  return null;
}

export function parseYamlScenario(source) {
  const rawLines = String(source ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const lines = rawLines
    .map(stripCommentLine)
    .filter((line) => line.trim() !== "")
    .map((raw) => ({ raw, indent: countIndent(raw), text: raw.trim() }));
  let index = 0;

  function peek() {
    return lines[index] ?? null;
  }

  function consume() {
    const line = lines[index];
    index += 1;
    return line;
  }

  function parseBlockScalar(parentIndent, style) {
    const collected = [];
    while (index < lines.length) {
      const line = peek();
      if (line.indent <= parentIndent) break;
      collected.push(consume());
    }
    if (collected.length === 0) return "";
    const contentIndent = Math.min(...collected.map((line) => line.indent));
    const parts = collected.map((line) => line.raw.slice(Math.min(line.raw.length, contentIndent)));
    if (style.startsWith(">")) {
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }
    return parts.join("\n").replace(/\n$/, "");
  }

  function parseValue(value, parentIndent) {
    if (value === "|" || value === "|-" || value === "|+") {
      return parseBlockScalar(parentIndent, value);
    }
    if (value === ">" || value === ">-" || value === ">+") {
      return parseBlockScalar(parentIndent, value);
    }
    if (value === "") {
      const next = peek();
      if (!next || next.indent <= parentIndent) return null;
      return parseBlock(next.indent);
    }
    return parseScalar(value);
  }

  function parseObject(indent) {
    const result = {};
    while (index < lines.length) {
      const line = peek();
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new Error(`Unexpected indentation near: ${line.raw}`);
      }
      if (line.text.startsWith("- ")) break;
      consume();
      const pair = splitKeyValue(line.text);
      if (!pair) throw new Error(`Expected key: value near: ${line.raw}`);
      result[pair.key] = parseValue(pair.value, indent);
    }
    return result;
  }

  function parseArray(indent) {
    const result = [];
    while (index < lines.length) {
      const line = peek();
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new Error(`Unexpected indentation near: ${line.raw}`);
      }
      if (!line.text.startsWith("- ")) break;
      consume();
      const itemText = line.text.slice(2).trim();
      if (!itemText) {
        const next = peek();
        result.push(next && next.indent > indent ? parseBlock(next.indent) : null);
        continue;
      }

      const pair = splitKeyValue(itemText);
      if (!pair) {
        result.push(parseScalar(itemText));
        continue;
      }

      const item = {};
      item[pair.key] = parseValue(pair.value, indent);
      while (index < lines.length) {
        const next = peek();
        if (next.indent <= indent) break;
        if (next.indent < indent + 2) {
          throw new Error(`Unexpected indentation near: ${next.raw}`);
        }
        if (next.text.startsWith("- ")) break;
        const nestedIndent = next.indent;
        const nested = parseObject(nestedIndent);
        Object.assign(item, nested);
      }
      result.push(item);
    }
    return result;
  }

  function parseBlock(indent) {
    const line = peek();
    if (!line) return null;
    return line.text.startsWith("- ") ? parseArray(indent) : parseObject(indent);
  }

  const first = peek();
  if (!first) return {};
  const parsed = parseBlock(first.indent);
  if (index < lines.length) {
    throw new Error(`Unexpected trailing YAML near: ${peek().raw}`);
  }
  return parsed;
}
