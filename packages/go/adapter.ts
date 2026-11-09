import { fileURLToPath } from "node:url";

import { type AdapterDefinition, type Finding, isRecord, serve } from "../sdk/adapter.ts";

// Plumb's optional Go adapter: source policy from a real tokenizer, with no Go toolchain needed.
// shortcut: it reads tokens, not types, so it cannot see through reflection, cgo or code
// generation; pair it with go vet in a verification suite when those matter.

interface Token {
  kind: "comment" | "string" | "word" | "mark";
  text: string;
  line: number;
  column: number;
}

const DIRECTIVE = /^\/\/\s*(?:nolint\b|#nosec\b|lint:(?:file-)?ignore\b|revive:disable\b)/;

const SKIPS = new Set(["Skip", "Skipf", "SkipNow"]);

// comments, strings and runes are whole tokens, so nothing inside one is mistaken for code
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
  const closing = (quote: string, from: number): number => {
    for (let at = from; at < source.length; at++) {
      if (source[at] === "\\" && quote !== "`") {
        at++;
      } else if (source[at] === quote) {
        return at + 1;
      } else if (source[at] === "\n" && quote !== "`") {
        break;
      }
    }
    throw new Error(`Unterminated literal on line ${line}`);
  };
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "\n") {
      line++;
      start = ++index;
    } else if (/\s/.test(char)) {
      index++;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      push("comment", end < 0 ? source.length : end);
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        throw new Error(`Unterminated comment on line ${line}`);
      }
      push("comment", end + 2);
    } else if (char === '"' || char === "`" || char === "'") {
      push("string", closing(char, index + 1));
    } else if (/[\p{L}_]/u.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\p{L}\p{Nd}_]/u.test(source[end] ?? "")) {
        end++;
      }
      push("word", end);
    } else {
      push("mark", index + 1);
    }
  }
  return tokens;
}

interface Restriction {
  path: string;
  reason: string;
}

const restrictionsOf = (options: Record<string, unknown>): Restriction[] =>
  (Array.isArray(options.forbiddenImports) ? options.forbiddenImports : []).flatMap(
    (entry: unknown): Restriction[] =>
      isRecord(entry) && typeof entry.path === "string" && typeof entry.reason === "string"
        ? [{ path: entry.path, reason: entry.reason }]
        : [],
  );

function check(file: { path: string; text: string }, options: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [],
    restrictions = restrictionsOf(options),
    tokens = tokenize(file.text),
    code = tokens.filter((token) => token.kind !== "comment");
  const at = ({ line, column }: Token): { line: number; column: number } => ({ line, column });
  for (const token of tokens) {
    if (token.kind === "comment" && DIRECTIVE.test(token.text)) {
      findings.push({
        rule: "directive",
        message: `Protected suppression directive: ${token.text}`,
        ...at(token),
      });
    }
  }
  const imported = (token: Token): void => {
    if (token.text.startsWith('"') && token.text.includes("\\")) {
      findings.push({
        rule: "import",
        message: "An import path written with escapes cannot be checked; write it literally.",
        status: "incomplete",
        ...at(token),
      });
      return;
    }
    const path = token.text.slice(1, -1);
    for (const entry of restrictions) {
      if (path === entry.path || path.startsWith(`${entry.path}/`)) {
        findings.push({
          rule: "import",
          message: `Import of ${entry.path} is forbidden: ${entry.reason}`,
          ...at(token),
        });
      }
    }
  };
  for (const [index, token] of code.entries()) {
    const next = code[index + 1];
    if (token.kind === "word" && token.text === "import" && restrictions.length) {
      // one spec, or a parenthesized group of them; an alias, dot or blank name precedes the path
      const grouped = next?.text === "(";
      for (let cursor = index + 1; cursor < code.length; cursor++) {
        const part = code[cursor];
        if (!part || part.text === ")") {
          break;
        }
        if (part.kind === "string") {
          imported(part);
          if (!grouped) {
            break;
          }
        }
      }
    }
    if (
      /_test\.go$/.test(file.path) &&
      token.text === "." &&
      next?.kind === "word" &&
      SKIPS.has(next.text) &&
      code[index + 2]?.text === "("
    ) {
      findings.push({
        rule: "skip",
        message: `${next.text} disables a test; fix or remove the test instead.`,
        ...at(next),
      });
    }
  }
  return findings;
}

export const definition: AdapterDefinition = {
  id: "go",
  version: "1.0.0",
  files: ["**/*.go"],
  capabilities: ["policy"],
  rules: [
    {
      id: "directive",
      description: "Lint and security suppression directives are prohibited.",
      remedy: "Remove the directive and correct the underlying source.",
      suppressible: false,
    },
    {
      id: "import",
      description: "Import declarations respect declared package boundaries.",
      remedy: "Use an allowed import or review a scoped core policy exception.",
    },
    {
      id: "skip",
      description: "Test files must not skip tests.",
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
            path: { type: "string", minLength: 1 },
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
