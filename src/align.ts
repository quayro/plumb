// dependency-free layout passes: Markdown tables, KEY # comment columns and JSON key order

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

export const displayWidth = (text: string): number => {
  let width = 0;
  for (const char of text) {
    width +=
      /\p{M}/u.test(char) || char === "‍" || char === "️"
        ? 0
        : WIDE.test(char) || /\p{Extended_Pictographic}/u.test(char)
          ? 2
          : 1;
  }
  return width;
};

type Side = "left" | "right" | "center";

const pad = (text: string, width: number, side: Side = "left"): string => {
  const gap = width - displayWidth(text);
  if (side === "right") {
    return " ".repeat(gap) + text;
  }
  if (side === "center") {
    return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
  }
  return text + " ".repeat(gap);
};

// split on unescaped pipes; as in GFM, a pipe inside a code span still splits unless escaped
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// line passes see LF lines; a CRLF file gets its CRLF endings back
const byLines = (source: string, pass: (lines: string[]) => string[]): string => {
  const crlf = source.includes("\r\n"),
    out = pass((crlf ? source.replaceAll("\r\n", "\n") : source).split("\n")).join("\n");
  return crlf ? out.replaceAll("\n", "\r\n") : out;
};

// a GFM table: the header and delimiter rows have the same cell count, and no body row has more
export const alignMarkdownTables = (source: string): string =>
  byLines(source, (lines) => {
    const out: string[] = [];
    let fence: string | null = null,
      i = 0;
    if (lines[0] === "---") {
      const end = lines.indexOf("---", 1);
      if (end > 0) {
        out.push(...lines.slice(0, end + 1));
        i = end + 1;
      }
    } // front matter
    for (; i < lines.length; i++) {
      const line = lines[i] ?? "",
        next = lines[i + 1] ?? "",
        indent = /^ */.exec(line)?.[0] ?? "";
      const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line),
        run = marker?.[1] ?? "";
      if (
        marker &&
        (!fence
          ? true
          : run[0] === fence[0] && run.length >= fence.length && !(marker[2] ?? "").trim())
      ) {
        fence = fence ? null : run;
        out.push(line);
        continue;
      }
      if (
        fence ||
        indent.length >= 4 ||
        !line.includes("|") ||
        !next.includes("|") ||
        !DELIMITER.test(next) ||
        !next.includes("-")
      ) {
        out.push(line);
        continue;
      }
      const header = cells(line),
        delimiter = cells(next);
      let end = i + 2;
      while (end < lines.length && lines[end]?.includes("|") && lines[end]?.trim()) {
        end++;
      }
      const rows = [header, ...lines.slice(i + 2, end).map(cells)];
      if (header.length !== delimiter.length || rows.some((row) => row.length > header.length)) {
        out.push(line);
        continue;
      }
      const sides = delimiter.map((spec): Side =>
        spec.startsWith(":") && spec.endsWith(":")
          ? "center"
          : spec.endsWith(":")
            ? "right"
            : "left",
      );
      const widths = header.map((_, column) =>
        Math.max(3, ...rows.map((row) => displayWidth(row[column] ?? ""))),
      );
      const print = (row: string[]): string =>
        `${indent}| ${widths.map((width, column) => pad(row[column] ?? "", width, sides[column])).join(" | ")} |`;
      out.push(print(header));
      out.push(
        `${indent}| ${widths
          .map((width, column) => {
            const spec = delimiter[column] ?? "";
            const left = spec.startsWith(":") ? ":" : "",
              right = spec.endsWith(":") ? ":" : "";
            return left + "-".repeat(width - left.length - right.length) + right;
          })
          .join(" | ")} |`,
      );
      for (const row of rows.slice(1)) {
        out.push(print(row));
      }
      i = end - 1;
    }
    return out;
  });

// NAME rest # comment, or NAME=value # comment; a # starts a comment only after whitespace and
// outside quotes
interface Key {
  name: string;
  assignment: boolean;
  rest: string;
  body: string;
  comment: string | null;
}

const parseKey = (line: string): Key | null => {
  const head = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)(=|\s+)/);
  if (!head) {
    return null;
  }
  let quote: string | null = null,
    comment = -1;
  for (let i = head[0].length; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && /\s/.test(line[i - 1] ?? "")) {
      comment = i;
      break;
    }
  }
  if (quote) {
    return null;
  }
  const body = (comment < 0 ? line : line.slice(0, comment)).trimEnd();
  return {
    name: head[1] ?? "",
    assignment: head[2] === "=",
    rest: body.slice(head[0].length).trim(),
    body,
    comment: comment < 0 ? null : line.slice(comment),
  };
};

export const alignKeyColumns = (source: string): string =>
  byLines(source, (lines) => {
    const out = [...lines];
    const flush = (run: { index: number; key: Key }[]): void => {
      const commented = run.filter(({ key }) => key.comment !== null);
      if (commented.length < 2) {
        return;
      }
      const nameWidth = Math.max(
        ...commented.filter(({ key }) => !key.assignment).map(({ key }) => displayWidth(key.name)),
        0,
      );
      const lead = ({ key }: { key: Key }): string =>
        key.assignment ? key.body : `${pad(key.name, nameWidth)} ${key.rest}`;
      const bodyWidth = Math.max(...commented.map((entry) => displayWidth(lead(entry))));
      for (const entry of commented) {
        out[entry.index] = `${pad(lead(entry), bodyWidth)} ${entry.key.comment ?? ""}`;
      }
    };
    let run: { index: number; key: Key }[] = [];
    lines.forEach((line, index) => {
      const key = line.trim() && !line.trimStart().startsWith("#") ? parseKey(line) : null;
      if (!key) {
        flush(run);
        run = [];
        return;
      }
      run.push({ index, key });
    });
    flush(run);
    return out;
  });

// a JSON tree that keeps each key and scalar as written, so sorting never rewrites a number, an
// escape or a duplicate key
interface JsonEntry {
  raw: string;
  key: string;
  value: JsonNode;
}

type JsonNode = { entries: JsonEntry[] } | { items: JsonNode[] } | { raw: string };

const parseJson = (text: string): JsonNode => {
  JSON.parse(text);
  let i = 0;
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i] ?? "")) {
      i++;
    }
  };
  const string = (): string => {
    const start = i++;
    while (text[i] !== '"') {
      i += text[i] === "\\" ? 2 : 1;
    }
    return text.slice(start, ++i);
  };
  const value = (): JsonNode => {
    space();
    if (text[i] === "{" || text[i] === "[") {
      const object = text[i++] === "{",
        close = object ? "}" : "]",
        entries: JsonEntry[] = [],
        items: JsonNode[] = [];
      space();
      while (text[i] !== close) {
        if (object) {
          space();
          const raw = string();
          space();
          i++;
          const key: unknown = JSON.parse(raw);
          entries.push({ raw, key: String(key), value: value() });
        } else {
          items.push(value());
        }
        space();
        if (text[i] === ",") {
          i++;
        }
        space();
      }
      i++;
      return object ? { entries } : { items };
    }
    if (text[i] === '"') {
      return { raw: string() };
    }
    const raw =
      /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i))?.[0] ??
      "";
    i += raw.length;
    return { raw };
  };
  return value();
};

const codePoints = (a: string, b: string): number => {
  const x = [...a],
    y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      return (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    }
  }
  return x.length - y.length;
};

const sortNode = (node: JsonNode, depth: number): JsonNode =>
  depth < 1 || !("entries" in node)
    ? node
    : {
        entries: [...node.entries]
          .sort((a, b) => codePoints(a.key, b.key))
          .map((entry) => ({ ...entry, value: sortNode(entry.value, depth - 1) })),
      };

const print = (node: JsonNode, indent = ""): string => {
  const inner = `${indent}  `;
  if ("entries" in node) {
    return node.entries.length
      ? `{\n${node.entries.map((entry) => `${inner}${entry.raw}: ${print(entry.value, inner)}`).join(",\n")}\n${indent}}`
      : "{}";
  }
  if ("items" in node) {
    return node.items.length
      ? `[\n${node.items.map((item) => `${inner}${print(item, inner)}`).join(",\n")}\n${indent}]`
      : "[]";
  }
  return node.raw;
};

export const sortJsonKeys = (source: string, depth = 1): string =>
  `${print(sortNode(parseJson(source), depth))}\n`;

// the key sequence at each level to depth, as written; whitespace is left to the formatter
type KeyShape = [string, KeyShape][] | null;

const shape = (node: JsonNode, depth: number): KeyShape =>
  depth < 1 || !("entries" in node)
    ? null
    : node.entries.map((entry) => [entry.key, shape(entry.value, depth - 1)]);

export const jsonKeyOrder = (source: string, depth = 1): string =>
  JSON.stringify(shape(parseJson(source), depth));
