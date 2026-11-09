const lines = (value: string): string[] => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const quote = (path: string): string =>
  '"' +
  [...path]
    .map((char) => {
      const code = char.charCodeAt(0);
      if (char === '"' || char === "\\") {
        return `\\${char}`;
      }
      // control characters are written as octal escapes
      return code < 0x20 || code === 0x7f ? `\\${code.toString(8).padStart(3, "0")}` : char;
    })
    .join("") +
  '"';

const patchLine = (prefix: string, value: string): string =>
  prefix + value + (value.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");

export function repairPatch(
  changes: readonly { path: string; before: string; after: string }[],
): string {
  return changes
    .map(({ path, before, after }) => {
      const a = lines(before),
        b = lines(after);
      let start = 0,
        suffix = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) {
        start++;
      }
      while (
        suffix < a.length - start &&
        suffix < b.length - start &&
        a[a.length - suffix - 1] === b[b.length - suffix - 1]
      ) {
        suffix++;
      }
      const from = Math.max(0, start - 3),
        context = Math.min(3, suffix),
        oldEnd = a.length - suffix + context,
        newEnd = b.length - suffix + context;
      const oldCount = oldEnd - from,
        newCount = newEnd - from;
      return (
        `--- ${quote(`a/${path}`)}\n+++ ${quote(`b/${path}`)}\n@@ -${oldCount ? from + 1 : from},${oldCount} +${newCount ? from + 1 : from},${newCount} @@\n` +
        a
          .slice(from, start)
          .map((line) => patchLine(" ", line))
          .join("") +
        a
          .slice(start, a.length - suffix)
          .map((line) => patchLine("-", line))
          .join("") +
        b
          .slice(start, b.length - suffix)
          .map((line) => patchLine("+", line))
          .join("") +
        a
          .slice(a.length - suffix, oldEnd)
          .map((line) => patchLine(" ", line))
          .join("")
      );
    })
    .join("");
}
