import type { Diagnostic } from "./diagnostics.ts";

export type Extra = Partial<Pick<Diagnostic, "line" | "column" | "status" | "suppressible">>;

interface Problem extends Extra {
  rule: string;
  line: number;
  message: string;
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface Parsed {
  ids: Set<string>;
  links: { href: string; line: number }[];
  problems: Problem[];
  headings: Heading[];
  fences: { line: number; info: string }[];
  lines: string[];
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const entities = (text: string): string =>
  text.replace(
    /&(?:#(x[\da-f]+|\d+)|(amp|lt|gt|quot|apos|nbsp));/gi,
    (whole, numeric: string | undefined, name: string | undefined) => {
      if (!numeric) {
        return NAMED[(name ?? "").toLowerCase()] ?? whole;
      }
      const code =
        numeric[0]?.toLowerCase() === "x" ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );

const unescape = (text: string): string =>
  entities(text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1"));

const label = (text: string): string => unescape(text).trim().replace(/\s+/g, " ").toLowerCase();

const mask = (text: string): string => text.replace(/[^\n]/g, " ");

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

// this scanner covers ordinary Markdown, reference links, HTML links, and GitHub-style headings.
// code spans, fenced/indented code, front matter and HTML comments are excluded from inspection.
export function markdown(text: string): Parsed {
  const problems: Problem[] = [],
    fences: Parsed["fences"] = [];
  const note = (rule: string, line: number, message: string, extra: Extra = {}): number =>
    problems.push({ rule, line, message, ...extra });
  const visible = text
    .replace(/<!--[^]*?(?:-->|$)/g, (comment, at: number) => {
      if (!comment.endsWith("-->")) {
        note("docs.syntax", lineOf(text, at), "An HTML comment is not closed.", {
          status: "incomplete",
          suppressible: false,
        });
      }
      return mask(comment);
    })
    .split(/\r?\n/);
  if (visible[0]?.trim() === "---") {
    const end = visible.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end > 0) {
      for (let index = 0; index <= end; index++) {
        visible[index] = mask(visible[index] ?? "");
      }
    }
  }
  let fence: { char: string; size: number; container: number; line: number } | undefined,
    listIndent = 0;
  visible.forEach((line, number) => {
    const indent = (/^ */.exec(line)?.[0] ?? "").length;
    const boundary = /^( *)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        boundary &&
        boundary[2][0] === fence.char &&
        boundary[2].length >= fence.size &&
        !boundary[3].trim() &&
        indent < fence.container + 4
      ) {
        fence = undefined;
      }
      visible[number] = mask(line);
      return;
    }
    if (
      boundary &&
      indent < listIndent + 4 &&
      (boundary[2][0] === "~" || !boundary[3].includes("`"))
    ) {
      fence = {
        char: boundary[2][0],
        size: boundary[2].length,
        container: listIndent,
        line: number + 1,
      };
      const info = boundary[3].trim();
      fences.push({ line: number + 1, info });
      if (!info) {
        note(
          "docs.fences",
          number + 1,
          "A fenced code block has no language; name it, or use text when none applies.",
        );
      }
      visible[number] = mask(line);
      return;
    }
    const item = /^\s*(?:[-+*]|\d+[.)])\s+/.exec(line);
    if (item) {
      listIndent = item[0].length;
    } else if (line.trim() && !/^\s/.test(line)) {
      listIndent = 0;
    }
    visible[number] = line.startsWith("\t") || indent >= listIndent + 4 ? mask(line) : line;
  });
  if (fence) {
    note("docs.syntax", fence.line, "A fenced code block is not closed.", {
      status: "incomplete",
      suppressible: false,
    });
  }

  const ids = new Set<string>(),
    headings: Heading[] = [];
  const addHeading = (heading: string): void => {
    const plain = entities(
      heading
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/!?\[([^\]]*)\](?:\[[^\]]*\])?/g, "$1")
        .replace(/<[^>]*>/g, "")
        .replace(/[*`~]/g, ""),
    );
    const slug = plain
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    let id = slug;
    for (let count = 1; ids.has(id); count++) {
      id = `${slug}-${count}`;
    }
    ids.add(id);
  };
  visible.forEach((line, number) => {
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(line);
    if (atx) {
      const text = (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      headings.push({ level: (atx[1] ?? "").length, text, line: number + 1 });
      addHeading(text);
    } else if (
      number &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) &&
      visible[number - 1]?.trim() &&
      !/^ {0,3}#/.test(visible[number - 1] ?? "")
    ) {
      const text = (visible[number - 1] ?? "").trim();
      headings.push({ level: line.trim()[0] === "=" ? 1 : 2, text, line: number });
      note(
        "docs.headings",
        number,
        "Use an ATX heading (# to ######) instead of an underlined heading.",
      );
      addHeading(text);
    }
  });
  const first = visible.findIndex((line) => line.trim()) + 1;
  const titles = headings.filter((heading) => heading.level === 1);
  if (titles.length !== 1) {
    note(
      "docs.headings",
      titles[1]?.line ?? 1,
      `A document needs exactly one H1 heading; found ${titles.length}.`,
    );
  } else if (titles[0].line !== first) {
    note("docs.headings", titles[0].line, "The H1 heading must be the first content line.");
  }
  headings.forEach((heading, index) => {
    const previous = headings[index - 1];
    if (previous && heading.level > previous.level + 1) {
      note(
        "docs.headings",
        heading.line,
        `Heading level skips from H${previous.level} to H${heading.level}.`,
      );
    }
  });
  const root = { level: 0, seen: new Set<string>() },
    scopes = [root];
  for (const heading of headings) {
    while ((scopes.at(-1)?.level ?? 0) >= heading.level && scopes.length > 1) {
      scopes.pop();
    }
    const scope = scopes.at(-1) ?? root,
      key = heading.text.toLowerCase().replace(/\s+/g, " ");
    if (scope.seen.has(key)) {
      note(
        "docs.headings",
        heading.line,
        `Heading "${heading.text}" repeats under the same parent.`,
      );
    }
    scope.seen.add(key);
    scopes.push({ level: heading.level, seen: new Set<string>() });
  }

  let body = visible.join("\n");
  // matching backtick runs may span a line; unmatched runs are ordinary prose.
  body = body.replace(/(`+)([^]*?)\1(?!`)/g, (span, _ticks, content: string, at: number) =>
    body[at - 1] === "`" || content.startsWith("`") ? span : mask(span),
  );
  const references = new Map<string, string | undefined>();
  const destination = (value: string): string | undefined => {
    const match = /^\s*(?:<((?:\\.|[^<>\n])*)>|((?:\\.|[^\s])+))/.exec(value);
    return match ? unescape(match[1] ?? match[2] ?? "") : undefined;
  };
  body = body.replace(/^ {0,3}\[([^\]\n]+)\]:[^\n]*$/gm, (definition, key: string) => {
    const href = destination(definition.slice(definition.indexOf(":") + 1));
    if (href !== undefined && !references.has(label(key))) {
      references.set(label(key), href);
    }
    return mask(definition);
  });
  const links: Parsed["links"] = [];
  for (const tag of body.matchAll(/<([a-z][\w-]*)\b([^<>]*)>/gi)) {
    for (const attribute of tag[2].matchAll(
      /\b(id|name|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    )) {
      const value = entities(attribute[2] ?? attribute[3] ?? attribute[4]);
      if (["id", "name"].includes(attribute[1].toLowerCase())) {
        ids.add(value);
      } else {
        links.push({ href: value, line: lineOf(body, tag.index) });
      }
    }
  }
  for (let at = 0; at < body.length; at++) {
    if (body[at] === "\\") {
      at++;
      continue;
    }
    if (body[at] !== "[") {
      continue;
    }
    let end = at + 1;
    let depth = 1;
    for (; end < body.length && depth; end++) {
      if (body[end] === "\\") {
        end++;
      } else if (body[end] === "[") {
        depth++;
      } else if (body[end] === "]") {
        depth--;
      }
    }
    if (depth) {
      continue;
    }
    const title = body.slice(at + 1, end - 1);
    let href: string | undefined;
    if (body[end] === "(") {
      let position = end + 1;
      while (/\s/.test(body[position] ?? "") && position < body.length) {
        position++;
      }
      const start = position;
      if (body[position] === "<") {
        position++;
        while (position < body.length && body[position] !== ">" && body[position] !== "\n") {
          if (body[position] === "\\") {
            position++;
          }
          position++;
        }
        if (body[position] !== ">") {
          continue;
        }
        href = unescape(body.slice(start + 1, position++));
      } else {
        depth = 0;
        for (; position < body.length; position++) {
          const char = body[position];
          if (char === "\\") {
            position++;
            continue;
          }
          if (char === "(") {
            depth++;
          } else if (char === ")") {
            if (!depth) {
              break;
            }
            depth--;
          } else if (/\s/.test(char) && !depth) {
            break;
          }
        }
        if (depth) {
          continue;
        }
        href = unescape(body.slice(start, position));
      }
      while (/\s/.test(body[position] ?? "") && position < body.length) {
        position++;
      }
      if (["'", '"', "("].includes(body[position])) {
        const closing = body[position] === "(" ? ")" : body[position];
        position++;
        while (position < body.length && body[position] !== closing) {
          if (body[position] === "\\") {
            position++;
          }
          position++;
        }
        if (body[position] !== closing) {
          continue;
        }
        position++;
        while (/\s/.test(body[position] ?? "") && position < body.length) {
          position++;
        }
      }
      if (body[position] !== ")") {
        continue;
      }
      end = position + 1;
    } else if (body[end] === "[") {
      const close = body.indexOf("]", end + 1);
      if (close < 0) {
        continue;
      }
      const key = label(body.slice(end + 1, close) || title);
      href = references.get(key);
      // a full or collapsed reference names a label that must be defined; a bare bracket is ordinary text
      if (href === undefined && !key.startsWith("^")) {
        note("docs.links", lineOf(body, at), `Undefined reference label ${key}.`);
      }
      end = close + 1;
    } else {
      href = references.get(label(title));
    }
    if (href !== undefined) {
      links.push({ href, line: lineOf(body, at) });
    }
    at = end - 1;
  }
  return { ids, links, problems, headings, fences, lines: visible };
}
