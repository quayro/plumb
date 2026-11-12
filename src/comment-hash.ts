import type { Scan } from "./comment-slash.ts";

// shell, YAML, env and Docker comments: a # that starts a word, outside quotes and heredocs
export function hashComments(source: string, language: string): Scan {
  const found: Scan["found"] = [];
  const issues: Scan["issues"] = [];
  let quote: string | undefined;
  let quotedAt = 0;
  let blockIndent: number | undefined;
  let offset = 0;
  const heredocs: { word: string; tabs: boolean; at: number; interpolates: boolean }[] = [];
  const issue = (index: number, message: string): number => issues.push({ index, message });
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
      const content = doc.tabs ? line.replace(/^\t+/, "") : line;
      if (content.replace(/\r$/, "") === doc.word) {
        heredocs.shift();
      } else if (doc.interpolates) {
        for (let index = 0; index < line.length; index++) {
          if (line[index] === "\\") {
            index++;
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
      if (quote) {
        if (char === "\\" && quote !== "'") {
          index++;
        } else if (char === quote) {
          if (language === "yaml" && quote === "'" && line[index + 1] === "'") {
            index++;
          } else {
            quote = undefined;
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
      if (
        (char === '"' || char === "'" || (language === "shell" && char === "`")) &&
        (language !== "yaml" ||
          !line.slice(0, index).trim() ||
          /[:[{,-]$/.test(line.slice(0, index).trimEnd()))
      ) {
        quote = char;
        quotedAt = offset + index;
      } else if (
        ["shell", "docker"].includes(language) &&
        line.startsWith("<<", index) &&
        line[index + 2] !== "<"
      ) {
        const token = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(line.slice(index));
        if (token) {
          heredocs.push({
            word: token[3] ?? "",
            tabs: token[1] === "-",
            at: offset + index,
            interpolates: !token[2],
          });
          index += token[0].length - 1;
        }
      } else if (
        char === "#" &&
        (index === 0 || (language === "shell" ? /[\s;|&()]/ : /\s/).test(line[index - 1]))
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
  if (heredocs.length) {
    issue(heredocs[0].at, "A heredoc is not closed.");
  }
  return { found, issues };
}
