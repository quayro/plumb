import type { Found, Scan } from "./comment-slash.ts";

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

export function hashComments(source: string, language: string): Scan {
  const found: Found[] = [];
  const issues: Scan["issues"] = [];
  let quote: string | undefined;
  let quotedAt = 0;
  let blockIndent: number | undefined;
  let rubyBlock: number | undefined;
  let literal:
    | {
        open: string;
        close: string;
        depth: number;
        at: number;
        interpolates: boolean;
        regexp?: boolean;
        characterClass?: boolean;
      }
    | undefined;
  let offset = 0;
  const heredocs: { word: string; indent: string; at: number; interpolates: boolean }[] = [];
  const issue = (index: number, message: string): number => issues.push({ index, message });
  const rubyInterpolation = (line: string, index: number): number => {
    const end = line.indexOf("}", index + 2);
    if (end < 0 || /[{}#]/.test(line.slice(index + 2, end))) {
      issue(
        offset + index,
        "Complex or multiline Ruby interpolation needs a parser-backed comment adapter.",
      );
      return -1;
    }
    return end;
  };
  const shellSubstitution = (line: string, index: number): number => {
    const end = line.indexOf(")", index + 2);
    if (end < 0 || /[#()]/.test(line.slice(index + 2, end))) {
      issue(
        offset + index,
        "Nested or multiline shell command substitution needs a parser-backed comment adapter.",
      );
      return -1;
    }
    return end;
  };
  for (const line of source.split("\n")) {
    if (heredocs.length) {
      const doc = heredocs[0];
      const content =
        doc.indent === "any"
          ? line.trimStart()
          : doc.indent === "tabs"
            ? line.replace(/^\t+/, "")
            : line;
      if (content.replace(/\r$/, "") === doc.word) {
        heredocs.shift();
      } else if (doc.interpolates) {
        for (let index = 0; index < line.length; index++) {
          if (line[index] === "\\") {
            index++;
          } else if (language === "ruby" && line.startsWith("#{", index)) {
            index = rubyInterpolation(line, index);
            if (index < 0) {
              return { found, issues };
            }
          } else if (language === "shell" && line.startsWith("$(", index)) {
            index = shellSubstitution(line, index);
            if (index < 0) {
              return { found, issues };
            }
          } else if (language === "shell" && line[index] === "`") {
            issue(
              offset + index,
              "Shell heredoc backtick substitution needs a parser-backed comment adapter.",
            );
            return { found, issues };
          }
        }
      }
      offset += line.length + 1;
      continue;
    }
    if (
      language === "ruby" &&
      !quote &&
      !literal &&
      (rubyBlock !== undefined || /^=begin(?:\s|$)/.test(line))
    ) {
      rubyBlock ??= offset;
      if (/^=end(?:\s|$)/.test(line)) {
        found.push({ index: rubyBlock, text: source.slice(rubyBlock + 6, offset), block: true });
        rubyBlock = undefined;
      }
      offset += line.length + 1;
      continue;
    }
    const indentation = line.length - line.trimStart().length;
    if (blockIndent !== undefined) {
      if (!line.trim() || indentation > blockIndent) {
        offset += line.length + 1;
        continue;
      }
      blockIndent = undefined;
    }
    let content = line;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (literal) {
        if (char === "\\") {
          index++;
        } else if (literal.interpolates && line.startsWith("#{", index)) {
          index = rubyInterpolation(line, index);
          if (index < 0) {
            return { found, issues };
          }
        } else if (literal.regexp && char === "[") {
          literal.characterClass = true;
        } else if (literal.regexp && char === "]") {
          literal.characterClass = false;
        } else if (literal.characterClass) {
          continue;
        } else if (literal.open !== literal.close && char === literal.open) {
          literal.depth++;
        } else if (char === literal.close && --literal.depth === 0) {
          literal = undefined;
        }
        continue;
      }
      if (quote) {
        if (
          char === "\\" &&
          (quote !== "'" || language === "ruby") &&
          !(language === "yaml" && quote === "'")
        ) {
          index++;
        } else if (char === quote) {
          if (language === "yaml" && quote === "'" && line[index + 1] === "'") {
            index++;
          } else {
            quote = undefined;
          }
        } else if (language === "ruby" && quote !== "'" && line.startsWith("#{", index)) {
          index = rubyInterpolation(line, index);
          if (index < 0) {
            return { found, issues };
          }
        } else if (language === "shell" && quote === '"' && line.startsWith("$(", index)) {
          index = shellSubstitution(line, index);
          if (index < 0) {
            return { found, issues };
          }
        } else if (
          language === "shell" &&
          quote === "`" &&
          char === "#" &&
          (index === 0 || /[\s;|&()]/.test(line[index - 1]))
        ) {
          issue(
            offset + index,
            "A comment inside shell backtick substitution needs a parser-backed comment adapter.",
          );
          return { found, issues };
        }
        continue;
      }
      if (language === "shell" && char === "\\") {
        index++;
        continue;
      }
      if (language === "ruby" && char === "?" && /["'`#\\]/.test(line[index + 1] ?? "")) {
        issue(
          offset + index,
          "Ruby character literals or compact ternaries need a parser-backed comment adapter.",
        );
        return { found, issues };
      }
      if (language === "ruby" && char === "%" && line[index + 1] !== "=") {
        const token = /^%([qQwWiIrxs]?)([^\w\s])/.exec(line.slice(index));
        if (token) {
          const open = token[2];
          literal = {
            open,
            close: CLOSERS[open] ?? open,
            depth: 1,
            at: offset + index,
            interpolates: !["q", "w", "i", "s"].includes(token[1] ?? ""),
          };
          index += token[0].length - 1;
          continue;
        }
      }
      if (language === "ruby" && char === "/") {
        const before = line.slice(0, index).trimEnd();
        if (!before || /(?:[=(,:[!~]|\b(?:if|unless|when|return))$/.test(before)) {
          literal = {
            open: "/",
            close: "/",
            depth: 1,
            at: offset + index,
            regexp: true,
            interpolates: true,
          };
        } else if (line.slice(index + 1).includes("#") && /[^\\]\//.test(line.slice(index + 1))) {
          issue(
            offset + index,
            "An ambiguous Ruby regexp/division expression needs a parser-backed comment adapter.",
          );
          return { found, issues };
        }
        continue;
      }
      if (
        (char === '"' || char === "'" || (["shell", "ruby"].includes(language) && char === "`")) &&
        (language !== "yaml" ||
          !line.slice(0, index).trim() ||
          /[:[{,-]$/.test(line.slice(0, index).trimEnd()))
      ) {
        quote = char;
        quotedAt = offset + index;
      } else if (
        ["shell", "docker", "ruby"].includes(language) &&
        line.startsWith("<<", index) &&
        line[index + 2] !== "<"
      ) {
        const token = (
          language === "ruby"
            ? /^<<([-~]?)(['"`]?)([A-Za-z_]\w*)\2/
            : /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/
        ).exec(line.slice(index));
        if (token) {
          heredocs.push({
            word: token[3] ?? "",
            indent: token[1] ? (language === "ruby" ? "any" : "tabs") : "none",
            at: offset + index,
            interpolates: language === "ruby" ? token[2] !== "'" : !token[2],
          });
          index += token[0].length - 1;
        }
      } else if (
        char === "#" &&
        (language === "ruby" ||
          index === 0 ||
          (language === "shell" ? /[\s;|&()]/ : /\s/).test(line[index - 1]))
      ) {
        content = line.slice(0, index);
        if (
          !(language === "docker" && content.trim()) &&
          !(offset === 0 && index === 0 && line.startsWith("#!"))
        ) {
          const text = line.slice(index + 1);
          if (!(language === "env" && /^\s*[A-Z][A-Z0-9_]*=/.test(text))) {
            found.push({ index: offset + index, text, block: false });
          }
        }
        break;
      }
    }
    if (language === "yaml" && !quote && /(?:^\s*-|:)\s*[|>][+-]?[1-9]?[+-]?\s*$/.test(content)) {
      blockIndent = indentation;
    }
    if (language === "docker") {
      quote = undefined;
    }
    offset += line.length + 1;
  }
  if (quote) {
    issue(quotedAt, "A quoted string is not closed.");
  }
  if (literal) {
    issue(literal.at, "A Ruby percent or regexp literal is not closed.");
  }
  if (rubyBlock !== undefined) {
    issue(rubyBlock, "A Ruby block comment is not closed.");
  }
  if (heredocs.length) {
    issue(heredocs[0].at, "A heredoc is not closed.");
  }
  return { found, issues };
}
