interface Found {
  index: number;
  text: string;
  block: boolean;
}

export interface Scan {
  found: Found[];
  issues: { index: number; message: string }[];
}

const RUST_RAW = /[bc]?r(#*)"/y; // a raw string opener: r#" or br" or cr##"

const matchAt = (pattern: RegExp, source: string, index: number): RegExpExecArray | null => {
  pattern.lastIndex = index;
  return pattern.exec(source);
};

// the marker of a documentation line is three characters: prisma's ///, Rust's /// and //!
const lineMarker = (source: string, index: number, language: string): number => {
  if (language === "prisma") {
    return source[index + 2] === "/" ? 3 : 2;
  }
  if (language === "rust") {
    const doc =
      source[index + 2] === "!" || (source[index + 2] === "/" && source[index + 3] !== "/");
    return doc ? 3 : 2;
  }
  return 2;
};

// JavaScript-family, CSS, SQL, prisma and Rust comments; Rust shares the // and nested /* */ rules
export function slashComments(source: string, language: string): Scan {
  const found: Found[] = [];
  const issues: Scan["issues"] = [];
  const issue = (index: number, message: string): number => issues.push({ index, message });
  const nested = language === "sql" || language === "rust";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const raw =
      language === "rust" && !/\w/.test(source[index - 1] ?? "")
        ? matchAt(RUST_RAW, source, index)
        : null;
    if (raw) {
      const hashes = raw[1];
      const end = source.indexOf(`"${hashes}`, index + raw[0].length);
      if (end < 0) {
        issue(index, "A Rust raw string is not closed.");
        break;
      }
      index = end + hashes.length;
      continue;
    }
    if (language === "rust" && char === "'") {
      if (source[index + 1] === "\\") {
        let end = index + 1;
        while (end < source.length && source[end] !== "'") {
          end += source[end] === "\\" ? 2 : 1;
        }
        if (end >= source.length) {
          issue(index, "A Rust character literal is not closed.");
          break;
        }
        index = end;
        continue;
      }
      // 'x' is a character; anything else after the quote is a lifetime or label, whose name is code
      const width = (source.codePointAt(index + 1) ?? 0) > 0xffff ? 2 : 1;
      if (source[index + 1 + width] === "'") {
        index += 1 + width;
      }
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
    if (char === '"' || (char === "'" && ["css", "sql"].includes(language))) {
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
      const delimiter = lineMarker(source, index, language);
      const end = source.indexOf("\n", index);
      found.push({
        index,
        text: source.slice(index + delimiter, end < 0 ? source.length : end),
        block: false,
      });
      index = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const start = index;
      let depth = 1;
      index += 2;
      for (; index < source.length && depth; index++) {
        if (nested && source.startsWith("/*", index)) {
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
        index: start,
        text: source.slice(start + 2, index - 2),
        block: true,
      });
      index--;
    }
  }
  return { found, issues };
}
