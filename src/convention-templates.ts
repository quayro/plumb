import { posix } from "node:path";

import { path } from "./convention-schema.ts";
import { normalize } from "./files.ts";
import { validateSchema } from "./schema.ts";

export type Values = Partial<Record<"name" | "dir" | "stem" | "ext", string>>;

export const fail = (message: string): never => {
  throw new TypeError(`conventions: ${message}`);
};

export const substitutes = ["name", "dir", "stem", "ext"];

export const valuesFor = (path: string, name?: string): Required<Values> => {
  const ext = posix.extname(path),
    stem = posix.basename(path, ext);
  return { name: name ?? stem, dir: posix.dirname(path), stem, ext };
};

export function expand(value: string, values: Values, isPath = false): string {
  const rendered = value.replace(
    /\{(name|dir|stem|ext)\}/g,
    (_match, name: "name" | "dir" | "stem" | "ext") =>
      values[name] ?? fail(`unsupported template substitution {${name}}`),
  );
  if (!isPath) {
    return rendered;
  }
  if (/[?*{}]/.test(rendered)) {
    fail("template paths must resolve to literal paths without unknown substitutions");
  }
  validateSchema(rendered, path, "conventions template path");
  const target = normalize(rendered);
  if (target === "." || target.length > 4096) {
    fail("template target must be a bounded file path");
  }
  return target;
}

export function validateTemplate(
  entry: { path: string; content?: string },
  variables: readonly string[],
): void {
  if (entry.path.length > 1024 || (entry.content?.length ?? 0) > 65536) {
    fail("templates are limited to 1024 path characters and 64 KiB of content");
  }
  const values = Object.fromEntries(
    variables.map((name) => [name, name === "dir" ? "src" : name === "ext" ? ".ts" : "example"]),
  );
  expand(entry.path, values, true);
  if (entry.content !== undefined) {
    expand(entry.content, values);
  }
}
