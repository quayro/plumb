import type { Scan } from "./comment-slash.ts";
import { asError } from "./errors.ts";

// a Python comment is a # outside every string and every f-string replacement field. Strings with
// any legal prefix are data, docstrings included; a format spec is literal text. Whatever this
// scanner cannot follow with confidence is an issue, never a pass.

const PREFIX = /^(?:[rRuU]|[bBfFtT][rR]?|[rR][bBfFtT])$/; // the string prefixes Python accepts
const WORD = /\w+/y;
// keywords that can stand directly before an expression, so a string may follow them with no space
const KEYWORDS = new Set([
  "and",
  "assert",
  "await",
  "case",
  "elif",
  "else",
  "for",
  "from",
  "if",
  "in",
  "is",
  "lambda",
  "match",
  "not",
  "or",
  "raise",
  "return",
  "while",
  "with",
  "yield",
]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

class Unlexable extends Error {
  index: number;

  constructor(index: number, message: string) {
    super(message);
    this.index = index;
  }
}

export function pythonComments(source: string): Scan {
  const found: Scan["found"] = [];
  const issues: Scan["issues"] = [];
  const fail = (index: number, message: string): never => {
    throw new Unlexable(index, message);
  };

  // code runs to the end of the source, or inside a replacement field to its closing brace
  const code = (start: number, field: boolean): number => {
    const open: string[] = [];
    let index = start;
    while (index < source.length) {
      const char = source[index];
      if (char === "#") {
        if (field) {
          fail(
            index,
            "A comment inside an f-string replacement field needs a parser-backed comment adapter.",
          );
        }
        const end = source.indexOf("\n", index);
        const stop = end < 0 ? source.length : end;
        if (index !== 0 || !source.startsWith("#!")) {
          found.push({ index, text: source.slice(index + 1, stop), block: false });
        }
        index = stop;
      } else if (char === '"' || char === "'") {
        index = string(index, "");
      } else if (/\w/.test(char)) {
        WORD.lastIndex = index;
        const word = WORD.exec(source)?.[0] ?? "";
        index += word.length;
        if (source[index] === '"' || source[index] === "'") {
          if (PREFIX.test(word)) {
            index = string(index, word);
          } else if (!KEYWORDS.has(word)) {
            // a keyword before a string is code (return"x"); any other word before one is not Python
            fail(index - word.length, `The Python string prefix "${word}" is not recognized.`);
          }
        }
      } else {
        if ("([{".includes(char)) {
          open.push(char);
        } else if (")]}".includes(char)) {
          if (char === "}" && field && open.length === 0) {
            return index;
          }
          if (open.pop() !== CLOSERS[char]) {
            fail(index, "Unbalanced Python brackets need a parser-backed comment adapter.");
          }
        } else if (char === ":" && field && open.length === 0) {
          return spec(index + 1);
        }
        index++;
      }
    }
    if (field) {
      fail(start, "An f-string replacement field is not closed.");
    }
    if (open.length) {
      fail(source.length, "Unclosed Python brackets need a parser-backed comment adapter.");
    }
    return index;
  };

  // returns the index after the closing quote; a string's contents are never comments
  const string = (start: number, prefix: string): number => {
    const quote = source[start];
    const delimiter = source.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
    const fstring = /[ft]/i.test(prefix);
    const raw = /r/i.test(prefix);
    let index = start + delimiter.length;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        if (fstring && !raw && source.startsWith("N{", index + 1)) {
          const close = source.indexOf("}", index + 3);
          if (close < 0) {
            fail(start, "A Python string is not closed.");
          }
          index = close + 1;
        } else {
          const next = source[index + 1];
          // a backslash before CRLF continues the line; the pair is one line break
          if (next === "\r" && source[index + 2] === "\n") {
            index += 3;
          } else {
            index += next === "{" || next === "}" ? 1 : 2;
          }
        }
      } else if (char === "\n" && delimiter.length === 1) {
        fail(start, "A Python string is not closed.");
      } else if (source.startsWith(delimiter, index)) {
        return index + delimiter.length;
      } else if (fstring && char === "{") {
        index = source.startsWith("{", index + 1) ? index + 2 : code(index + 1, true) + 1;
      } else if (fstring && char === "}") {
        if (source[index + 1] !== "}") {
          fail(index, "An f-string has a single closing brace.");
        }
        index += 2;
      } else {
        index++;
      }
    }
    return fail(start, "A Python string is not closed.");
  };

  // a format spec is literal text, so a # in it is data; a nested field inside it is code
  const spec = (start: number): number => {
    for (let index = start; index < source.length; index++) {
      if (source[index] === "{") {
        index = code(index + 1, true);
      } else if (source[index] === "}") {
        return index;
      }
    }
    return fail(start, "An f-string format spec is not closed.");
  };

  try {
    code(0, false);
  } catch (error) {
    if (!(error instanceof Unlexable)) {
      throw asError(error);
    }
    issues.push({ index: error.index, message: error.message });
  }
  return { found, issues };
}
