export interface Found {
  index: number;
  text: string;
  block: boolean;
}

export interface Scan {
  found: Found[];
  issues: { index: number; message: string }[];
}

export function slashComments(original: string, language: string): Scan {
  const found: Found[] = [];
  const issues: Scan["issues"] = [];
  // C/C++ line splicing happens before tokenization; retain original source positions.
  const positions: number[] = [];
  let source = "";
  for (let at = 0; at < original.length; at++) {
    const splice = language === "cpp" && /^\\\r?\n/.exec(original.slice(at));
    if (splice) {
      at += splice[0].length - 1;
    } else {
      positions.push(at);
      source += original[at];
    }
  }
  const issue = (index: number, message: string): number =>
    issues.push({ index: positions[index] ?? original.length, message });
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const raw =
      language === "cpp" && /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/.exec(source.slice(index));
    if (raw) {
      const end = source.indexOf(`)${raw[1]}"`, index + raw[0].length);
      if (end < 0) {
        issue(index, "A C++ raw string is not closed.");
        break;
      }
      index = end + raw[1].length + 1;
      continue;
    }
    const dollar = language === "sql" && /^\$(?:[A-Za-z_]\w*)?\$/.exec(source.slice(index));
    if (dollar) {
      const end = source.indexOf(dollar[0], index + dollar[0].length);
      if (end < 0) {
        issue(index, "A SQL dollar-quoted string is not closed.");
        break;
      }
      index = end + dollar[0].length - 1;
      continue;
    }
    if (language === "css" && /^url\(/i.test(source.slice(index))) {
      let end = index + 4;
      let quote;
      for (; end < source.length; end++) {
        if (source[end] === "\\") {
          end++;
        } else if (quote) {
          if (source[end] === quote) {
            quote = undefined;
          }
        } else if (["'", '"'].includes(source[end])) {
          quote = source[end];
        } else if (source[end] === ")") {
          break;
        }
      }
      if (end === source.length) {
        issue(index, "A CSS url() token is not closed.");
        break;
      }
      index = end;
      continue;
    }
    const separator =
      language === "cpp" &&
      char === "'" &&
      /[\da-f]/i.test(source[index + 1] ?? "") &&
      /\b(?:0[xX][\da-fA-F']*|0[bB][01']*|\d[\w.']*)$/.test(source.slice(0, index));
    if (separator) {
      continue;
    }
    if (char === '"' || (char === "'" && ["cpp", "css", "sql"].includes(language))) {
      let end = index + 1;
      for (; end < source.length; end++) {
        if (
          source[end] === "\\" &&
          (language !== "sql" || /(?:^|\W)[eE]$/.test(source.slice(0, index)))
        ) {
          end++;
        } else if (source[end] === char) {
          if (language === "sql" && source[end + 1] === char) {
            end++;
          } else {
            break;
          }
        }
      }
      if (end >= source.length) {
        issue(index, "A quoted string is not closed.");
        break;
      }
      index = end;
      continue;
    }
    const line = language === "sql" ? "--" : "//";
    if (language !== "css" && source.startsWith(line, index)) {
      const delimiter = language === "prisma" && source[index + 2] === "/" ? 3 : 2;
      const end = source.indexOf("\n", index);
      found.push({
        index: positions[index],
        text: source.slice(index + delimiter, end < 0 ? source.length : end),
        block: false,
      });
      index = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const start = index;
      let depth = 1;
      index += 2;
      for (; index < source.length && depth; index++) {
        if (language === "sql" && source.startsWith("/*", index)) {
          depth++;
          index++;
        } else if (source.startsWith("*/", index)) {
          depth--;
          index++;
        }
      }
      if (depth) {
        issue(start, "A block comment is not closed.");
        break;
      }
      found.push({
        index: positions[start],
        text: source.slice(start + 2, index - 2),
        block: true,
      });
      index--;
    }
  }
  return { found, issues };
}
