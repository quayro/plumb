import { fileURLToPath } from "node:url";

import { type AdapterDefinition, type Finding, isRecord, serve } from "../sdk/adapter.ts";

// Plumb's optional Rust adapter: source policy from a token-level reader, with no Rust toolchain.
// shortcut: it reads tokens and the use declarations of one file, so it cannot see macro
// expansion, re-exports from other files or types reached without a name; the README lists them.

interface Token {
  kind: "comment" | "literal" | "lifetime" | "word" | "mark";
  text: string;
  line: number;
  column: number;
}

interface Hit {
  rule: "directive" | "import" | "skip";
  status: "violation" | "incomplete";
  message: string;
  token: Token;
}

interface Leaf {
  path: string[];
  token: Token;
  glob: boolean;
}

interface Binding {
  name: string;
  path: string[];
}

interface Restriction {
  path: string;
  reason: string;
}

const ID_START = /[\p{ID_Start}_]/u;
const ID_CONTINUE = /\p{ID_Continue}/u;
const PAIRS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);
const STD = new Set(["std", "core", "alloc"]);
// crate, self, super and Self begin local paths, so a check never resolves them
const KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "become",
  "box",
  "break",
  "const",
  "continue",
  "crate",
  "do",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "final",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "macro",
  "match",
  "mod",
  "move",
  "mut",
  "override",
  "priv",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "unsafe",
  "unsized",
  "use",
  "virtual",
  "where",
  "while",
  "yield",
]);
// macros that build or splice code this file does not show, so a path inside them is unseen
const SPLICERS = new Set(["paste", "concat_idents", "include"]);

const charAt = (source: string, at: number): string => {
  const code = source.codePointAt(at);
  return code === undefined ? "" : String.fromCodePoint(code);
};

// raw identifiers keep their r# in the token text; the name is the identifier itself
const nameOf = (token: Token): string =>
  token.kind === "word" && token.text.startsWith("r#") ? token.text.slice(2) : token.text;

const mark = (token: Token | undefined, text: string): boolean =>
  token?.kind === "mark" && token.text === text;

const keyword = (token: Token | undefined, text: string): boolean =>
  token?.kind === "word" && token.text === text;

// comments, literals and lifetimes are whole tokens, so nothing inside one is mistaken for code
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0,
    line = 1,
    start = 0;
  const push = (kind: Token["kind"], end: number): void => {
    const text = source.slice(index, end);
    tokens.push({ kind, text, line, column: index - start + 1 });
    for (let offset = text.indexOf("\n"); offset >= 0; offset = text.indexOf("\n", offset + 1)) {
      line++;
      start = index + offset + 1;
    }
    index = end;
  };
  const identifierEnd = (from: number): number => {
    let end = from;
    for (let ch = charAt(source, end); ch && ID_CONTINUE.test(ch); ch = charAt(source, end)) {
      end += ch.length;
    }
    return end;
  };
  const quoted = (from: number): number => {
    for (let at = from; at < source.length; at++) {
      if (source[at] === "\\") {
        at++;
      } else if (source[at] === '"') {
        return at + 1;
      }
    }
    throw new Error(`Unterminated string on line ${line}`);
  };
  // the end of r#"..."# once the closing quote is followed by as many hashes as opened it
  const raw = (quote: number, hashes: number): number => {
    const close = `"${"#".repeat(hashes)}`;
    const at = source.indexOf(close, quote + 1);
    if (at < 0) {
      throw new Error(`Unterminated raw string on line ${line}`);
    }
    return at + close.length;
  };
  // a character literal ends at the quote after one character or escape; -1 means a lifetime
  const character = (at: number): number => {
    if (source[at + 1] === "\\") {
      const close = source.indexOf("'", at + 3);
      if (close < 0 || source.slice(at, close).includes("\n")) {
        throw new Error(`Unterminated character literal on line ${line}`);
      }
      return close + 1;
    }
    const next = at + 1 + charAt(source, at + 1).length;
    return source[next] === "'" ? next + 1 : -1;
  };
  // b"", b'', c"", r"", r#""#, br##""##, cr"" and r#identifier, or undefined for a plain word
  const prefixed = (at: number): { kind: Token["kind"]; end: number } | undefined => {
    const head = /^(?:br|cr|b|c|r)/.exec(source.slice(at, at + 2))?.[0];
    if (!head) {
      return undefined;
    }
    const quote = at + head.length;
    if (head === "b" || head === "c") {
      if (source[quote] === '"') {
        return { kind: "literal", end: quoted(quote + 1) };
      }
      if (head === "b" && source[quote] === "'") {
        const end = character(quote);
        if (end < 0) {
          throw new Error(`Unterminated byte literal on line ${line}`);
        }
        return { kind: "literal", end };
      }
    }
    if (head === "r" || head.length === 2) {
      let hashes = 0;
      while (source[quote + hashes] === "#") {
        hashes++;
      }
      if (source[quote + hashes] === '"') {
        return { kind: "literal", end: raw(quote + hashes, hashes) };
      }
      if (head === "r" && hashes === 1 && ID_START.test(charAt(source, quote + 1))) {
        return { kind: "word", end: identifierEnd(quote + 1) };
      }
    }
    return undefined;
  };

  const shebang = /^#!(?!\s*\[)[^\n]*/.exec(source);
  if (shebang) {
    push("comment", shebang[0].length);
  }
  while (index < source.length) {
    const char = charAt(source, index);
    const literal = /[bcr]/.test(char) ? prefixed(index) : undefined;
    if (char === "\n") {
      line++;
      start = ++index;
    } else if (/\s/.test(char)) {
      index++;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      push("comment", end < 0 ? source.length : end);
    } else if (source.startsWith("/*", index)) {
      // block comments nest in Rust, so the first */ does not always close one
      let depth = 0,
        at = index;
      do {
        if (at >= source.length) {
          throw new Error(`Unterminated comment on line ${line}`);
        }
        if (source.startsWith("/*", at)) {
          depth++;
          at += 2;
        } else if (source.startsWith("*/", at)) {
          depth--;
          at += 2;
        } else {
          at++;
        }
      } while (depth > 0);
      push("comment", at);
    } else if (literal) {
      push(literal.kind, literal.end);
    } else if (char === '"') {
      push("literal", quoted(index + 1));
    } else if (char === "'") {
      const end = character(index);
      if (end >= 0) {
        push("literal", end);
      } else if (ID_START.test(charAt(source, index + 1))) {
        push("lifetime", identifierEnd(index + 1));
      } else {
        throw new Error(`Unterminated character literal on line ${line}`);
      }
    } else if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (/[0-9A-Za-z_]/.test(source[end] ?? "")) {
        end++;
      }
      push("word", end);
    } else if (ID_START.test(char)) {
      push("word", identifierEnd(index));
    } else if (source.startsWith("::", index)) {
      push("mark", index + 2);
    } else {
      push("mark", index + char.length);
    }
  }
  return tokens;
}

// the index of the bracket that closes the one at `open`; unbalanced brackets throw
function closing(tokens: readonly Token[], open: number): number {
  const expected: string[] = [];
  for (let at = open; at < tokens.length; at++) {
    const token = tokens[at];
    if (token?.kind !== "mark") {
      continue;
    }
    const close = PAIRS.get(token.text);
    if (close !== undefined) {
      expected.push(close);
    } else if (expected.length && [")", "]", "}"].includes(token.text)) {
      if (expected.pop() !== token.text) {
        throw new Error(`Unbalanced ${token.text} on line ${token.line}`);
      }
      if (expected.length === 0) {
        return at;
      }
    }
  }
  throw new Error(`Unclosed ${tokens[open]?.text ?? "bracket"} on line ${tokens[open]?.line}`);
}

// the comma-separated parts between two indexes, at the top level only; empty parts are dropped
function splitTop(tokens: readonly Token[], from: number, to: number): Token[][] {
  const parts: Token[][] = [];
  let depth = 0,
    current: Token[] = [];
  for (let at = from; at < to; at++) {
    const token = tokens[at];
    if (!token) {
      continue;
    }
    if (token.kind === "mark") {
      if (PAIRS.has(token.text)) {
        depth++;
      } else if ([")", "]", "}"].includes(token.text)) {
        depth--;
      } else if (token.text === "," && depth === 0) {
        parts.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  parts.push(current);
  return parts.filter((part) => part.length > 0);
}

// a cfg predicate decided from its tokens alone: true, false, or undefined when it needs the build
function decide(tokens: readonly Token[]): boolean | undefined {
  const [first, open] = tokens;
  if (tokens.length === 1 && first?.kind === "word") {
    return first.text === "true" ? true : first.text === "false" ? false : undefined;
  }
  if (first?.kind !== "word" || !mark(open, "(") || closing(tokens, 1) !== tokens.length - 1) {
    return undefined;
  }
  const values = splitTop(tokens, 2, tokens.length - 1).map(decide);
  switch (first.text) {
    case "any":
      return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
    case "all":
      return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
    case "not":
      return values.length === 1 ? (values[0] === undefined ? undefined : !values[0]) : undefined;
    default:
      return undefined;
  }
}

// the hits of one attribute body, the tokens between its brackets; cfg_attr is read recursively
function attributeHits(body: readonly Token[], at: Token, nested: boolean): Hit[] {
  const hits: Hit[] = [];
  const report = (rule: Hit["rule"], status: Hit["status"], message: string): void => {
    hits.push({ rule, status, message, token: at });
  };
  const head = mark(body[0], "::") ? 1 : 0;
  if (mark(body[head], "$")) {
    // a matcher such as $m:meta is harmless; a transcriber such as #[$m] may expand to anything
    if (!mark(body[head + 2], ":")) {
      const message =
        "An attribute built from a macro variable cannot be checked; write it literally.";
      report("directive", "incomplete", message);
      report("skip", "incomplete", message);
    }
    return hits;
  }
  const path: string[] = [];
  let next = head;
  for (let token = body[next]; token?.kind === "word"; token = body[next]) {
    path.push(nameOf(token));
    next++;
    if (!mark(body[next], "::") || body[next + 1]?.kind !== "word") {
      break;
    }
    next++;
  }
  if (path.length === 0) {
    return hits;
  }
  const name = path.join("::"),
    args = mark(body[next], "(") ? closing(body, next) : -1;
  if (name === "cfg_attr" && args >= 0) {
    // the first part is the predicate; every attribute after it applies when the predicate holds
    for (const part of splitTop(body, next + 1, args).slice(1)) {
      hits.push(...attributeHits(part, at, true));
    }
    return hits;
  }
  if (name === "allow" || name === "expect") {
    report(
      "directive",
      "violation",
      `#[${name}] suppresses a lint; remove it and correct the code.`,
    );
  }
  if (path[0] === "rustfmt" && path[1] === "skip") {
    report("directive", "violation", "rustfmt::skip hides code from formatting review; remove it.");
  }
  if (name === "ignore") {
    report("skip", "violation", "ignore disables a test; fix or remove the test instead.");
  }
  if (name === "cfg" && args >= 0 && !nested && decide(body.slice(next + 1, args)) === false) {
    report("skip", "violation", "A cfg gate that is always false disables this item; remove it.");
  }
  return hits;
}

function directiveAndSkipHits(code: readonly Token[]): Hit[] {
  const hits: Hit[] = [];
  for (let at = 0; at < code.length; at++) {
    const hash = code[at];
    if (!hash || !mark(hash, "#")) {
      continue;
    }
    const open = mark(code[at + 1], "!") ? at + 2 : at + 1;
    if (!mark(code[open], "[")) {
      continue;
    }
    hits.push(...attributeHits(code.slice(open + 1, closing(code, open)), hash, false));
  }
  return hits;
}

// one use tree: a path, a glob, a rename or a brace group; it records what each leaf brings in
function tree(
  code: readonly Token[],
  at: number,
  prefix: string[],
  leaves: Leaf[],
  bindings: Binding[],
): number {
  const first = mark(code[at], "::") ? at + 1 : at;
  const token = code[first];
  if (mark(token, "{")) {
    let next = first + 1;
    while (!mark(code[next], "}")) {
      next = tree(code, next, prefix, leaves, bindings);
      if (mark(code[next], ",")) {
        next++;
      } else if (!mark(code[next], "}")) {
        throw new Error(`Unsupported use declaration on line ${token.line}`);
      }
    }
    return next + 1;
  }
  if (mark(token, "*")) {
    leaves.push({ path: prefix, token, glob: true });
    return first + 1;
  }
  if (token?.kind !== "word") {
    throw new Error(`Unsupported use declaration on line ${code[at]?.line ?? "end"}`);
  }
  let next = first + 1;
  const name = nameOf(token);
  if (mark(code[next], "::")) {
    return tree(code, next + 1, [...prefix, name], leaves, bindings);
  }
  const full = name === "self" ? prefix : [...prefix, name];
  let bound = name === "self" ? (prefix[prefix.length - 1] ?? "") : name;
  if (keyword(code[next], "as")) {
    const alias = code[next + 1];
    if (alias?.kind !== "word") {
      throw new Error(`Unsupported rename on line ${token.line}`);
    }
    bound = nameOf(alias);
    next += 2;
  }
  leaves.push({ path: full, token, glob: false });
  if (full.length && bound !== "_" && !(full.length === 1 && full[0] === bound)) {
    bindings.push({ name: bound, path: full });
  }
  return next;
}

// returns the index after a use or extern crate declaration that starts at `at`, or 0 for none
function declaration(
  code: readonly Token[],
  at: number,
  leaves: Leaf[],
  bindings: Binding[],
): number {
  const token = code[at];
  if (keyword(token, "use")) {
    const end = tree(code, at + 1, [], leaves, bindings);
    if (!mark(code[end], ";")) {
      throw new Error(`A use declaration on line ${token?.line} is not terminated`);
    }
    return end + 1;
  }
  const crate = code[at + 2];
  if (keyword(token, "extern") && keyword(code[at + 1], "crate") && crate?.kind === "word") {
    const name = nameOf(crate);
    let bound = name,
      next = at + 3;
    if (keyword(code[next], "as")) {
      const alias = code[next + 1];
      if (alias?.kind !== "word") {
        throw new Error(`Unsupported rename on line ${crate.line}`);
      }
      bound = nameOf(alias);
      next += 2;
    }
    if (!mark(code[next], ";")) {
      throw new Error(`An extern crate declaration on line ${crate.line} is not terminated`);
    }
    leaves.push({ path: [name], token: crate, glob: false });
    if (bound !== name && bound !== "_") {
      bindings.push({ name: bound, path: [name] });
    }
    return next + 1;
  }
  return 0;
}

// the paths a name can stand for: a bound name expands through its use, std/core/alloc are one crate
function resolve(path: readonly string[], bindings: readonly Binding[], depth = 0): string[][] {
  if (depth > 16) {
    throw new Error("A chain of use declarations is too deep to resolve");
  }
  const [head = "", ...rest] = path;
  const targets = bindings.filter((binding) => binding.name === head);
  if (targets.length) {
    return targets
      .flatMap((binding) => resolve(binding.path, bindings, depth + 1))
      .map((resolved) => [...resolved, ...rest]);
  }
  return [STD.has(head) ? ["std", ...rest] : [...path]];
}

// a forbidden path as written, with a leading :: dropped and core or alloc read as std
const normalize = (path: string): string[] => {
  const segments = path.replace(/^::/, "").split("::");
  return STD.has(segments[0] ?? "") ? ["std", ...segments.slice(1)] : segments;
};

const reaches = (candidate: readonly string[], forbidden: readonly string[]): boolean =>
  candidate.length >= forbidden.length && forbidden.every((segment, k) => candidate[k] === segment);

const beforeIt = (candidate: readonly string[], forbidden: readonly string[]): boolean =>
  candidate.length < forbidden.length && candidate.every((segment, k) => forbidden[k] === segment);

function importHits(code: readonly Token[], restrictions: readonly Restriction[]): Hit[] {
  if (restrictions.length === 0) {
    return [];
  }
  const leaves: Leaf[] = [],
    bindings: Binding[] = [],
    skipped = new Set<number>();
  for (let at = 0; at < code.length; at++) {
    const end = declaration(code, at, leaves, bindings);
    for (let k = at; k < end; k++) {
      skipped.add(k);
    }
    if (end) {
      at = end - 1;
    }
  }
  const hits: Hit[] = [];
  const report = (status: Hit["status"], token: Token, message: string): void => {
    hits.push({ rule: "import", status, message, token });
  };
  for (const entry of restrictions) {
    const forbidden = normalize(entry.path),
      denied = `${entry.path} is forbidden: ${entry.reason}`;
    for (const leaf of leaves) {
      for (const candidate of resolve(leaf.path, bindings)) {
        if (reaches(candidate, forbidden)) {
          report("violation", leaf.token, `Import of ${denied}`);
        } else if (leaf.glob && (beforeIt(candidate, forbidden) || candidate[0] !== "std")) {
          // a glob of a strict prefix, or of a path this file cannot resolve, could bring it in
          report(
            "incomplete",
            leaf.token,
            `A glob import of ${candidate.join("::") || "self"} could bring ${entry.path} into scope; import the names explicitly.`,
          );
        }
      }
    }
  }
  for (let at = 0; at < code.length; at++) {
    if (skipped.has(at)) {
      continue;
    }
    const token = code[at],
      prev = code[at - 1],
      before = code[at - 2];
    const variable = code[at + 1];
    if (token && mark(token, "$") && variable?.kind === "word" && mark(code[at + 2], "::")) {
      if (nameOf(variable) !== "crate") {
        report(
          "incomplete",
          token,
          "A path built from a macro variable cannot be checked; write it literally.",
        );
      }
      continue;
    }
    if (token?.kind !== "word" || KEYWORDS.has(token.text)) {
      continue;
    }
    if (mark(code[at + 1], "!") && SPLICERS.has(token.text)) {
      report(
        "incomplete",
        token,
        "A macro that splices code cannot be checked; write the path literally.",
      );
      continue;
    }
    // a segment after :: or a field or method after ., and a name after a macro variable, are not starts
    if (
      (mark(prev, "::") && before?.kind === "word") ||
      (mark(prev, ".") && !mark(before, ".")) ||
      mark(prev, "$")
    ) {
      continue;
    }
    const path = [nameOf(token)];
    for (let next = at + 1; mark(code[next], "::"); next += 2) {
      const segment = code[next + 1];
      if (segment?.kind !== "word") {
        break;
      }
      path.push(nameOf(segment));
    }
    for (const entry of restrictions) {
      const forbidden = normalize(entry.path);
      if (resolve(path, bindings).some((candidate) => reaches(candidate, forbidden))) {
        report("violation", token, `Use of ${entry.path} is forbidden: ${entry.reason}`);
      }
    }
  }
  return hits;
}

const restrictionsOf = (options: Record<string, unknown>): Restriction[] =>
  (Array.isArray(options.forbiddenImports) ? options.forbiddenImports : []).flatMap(
    (entry: unknown): Restriction[] =>
      isRecord(entry) && typeof entry.path === "string" && typeof entry.reason === "string"
        ? [{ path: entry.path, reason: entry.reason }]
        : [],
  );

function check(file: { path: string; text: string }, options: Record<string, unknown>): Finding[] {
  const code = tokenize(file.text).filter((token) => token.kind !== "comment");
  const hits = [...directiveAndSkipHits(code), ...importHits(code, restrictionsOf(options))];
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const { rule, status, message, token } of hits) {
    const key = `${rule}:${status}:${token.line}:${token.column}:${message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    findings.push({
      rule,
      message,
      line: token.line,
      column: token.column,
      ...(status === "incomplete" ? { status } : {}),
    });
  }
  return findings;
}

export const definition: AdapterDefinition = {
  id: "rust",
  version: "1.0.0",
  files: ["**/*.rs"],
  capabilities: ["policy"],
  rules: [
    {
      id: "directive",
      description: "Lint suppression attributes are prohibited.",
      remedy: "Remove the attribute and correct the underlying source.",
      suppressible: false,
    },
    {
      id: "import",
      description: "Imports and paths respect declared package boundaries.",
      remedy: "Use an allowed path or review a scoped core policy exception.",
    },
    {
      id: "skip",
      description: "Tests must not be disabled.",
      remedy: "Fix the test or remove it from the suite.",
      suppressible: false,
    },
  ],
  optionsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      forbiddenImports: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "reason"],
          properties: {
            path: {
              type: "string",
              minLength: 1,
              pattern: "^(?:::)?[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$",
            },
            reason: { type: "string", minLength: 1, pattern: "\\S" },
          },
        },
      },
    },
  },
  check,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  serve(definition, process.argv[1]);
}
