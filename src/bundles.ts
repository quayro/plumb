import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { Origins, PolicyOrigin } from "./diagnostics.ts";
import { canonical, digest, isWithin, normalize, safePath } from "./files.ts";
import { isArray, isRecord, type Shape, validateSchema } from "./schema.ts";

type Validate = (value: unknown, shape: Shape, at?: string) => void;

export interface PolicyInput {
  path: string;
  sha256: string;
}

interface Resolved {
  value: unknown;
  origins: Origins;
}

export interface PolicyChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
  beforeOrigins?: PolicyOrigin[];
  afterOrigins?: PolicyOrigin[];
}

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

export const BUNDLE_REFERENCE_SCHEMA = {
  type: "object",
  required: ["path", "sha256"],
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    bindings: {
      type: "object",
      additionalProperties: { type: "string", minLength: 1, format: "path" },
    },
  },
} as const;

const additive = new Set([
  "/projects",
  "/files/required",
  "/files/forbidden",
  "/files/names",
  "/policy/protected",
  "/verification",
  "/policyTests",
  "/rules",
  "/format/sortKeys",
  "/conventions/files",
  "/conventions/roles",
  "/javascript/rules",
  "/javascript/syntax",
  "/javascript/clientDirective",
]);
const allowances = new Set([
  "/exclude",
  "/exceptions",
  "/format/ignore",
  "/javascript/source",
  "/javascript/words",
  "/javascript/lines",
  "/javascript/errorFactory/allowIn",
]);

const isAdditive = (path: string): boolean =>
  additive.has(path) || /^\/contracts\/[^/]+$/.test(path);

const escape = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");

const plain = isRecord;

const clone = <T>(value: T): T => structuredClone(value);

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function localFile(file: unknown, directory: string): string {
  if (
    typeof file !== "string" ||
    !file ||
    file.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(file) ||
    file.startsWith("file:")
  ) {
    throw new TypeError("Policy bundles must use local filesystem paths");
  }
  if (normalize(file).split("/").includes("..")) {
    throw new TypeError(`Bundle paths cannot traverse parent directories: ${file}`);
  }
  const absolute = isAbsolute(file)
    ? safePath(dirname(file), basename(file))
    : safePath(directory, file);
  if (!lstatSync(absolute).isFile()) {
    throw new TypeError(`Policy bundle is not a regular file: ${file}`);
  }
  return realpathSync(absolute);
}

function bindPaths(
  value: unknown,
  shape: Shape | undefined,
  bindings: Record<string, unknown>,
  validate: Validate,
  used = new Set<string>(),
): unknown {
  if (shape?.format === "path" || shape?.format === "glob") {
    if (typeof value !== "string" || !value.includes("${")) {
      return value;
    }
    const match = /^\$\{([a-z][a-z0-9_-]*)\}(?:\/|$)/i.exec(value);
    const name = match?.[1];
    if (
      !match ||
      !name ||
      !Object.hasOwn(bindings, name) ||
      value.slice(match[0].length).includes("${")
    ) {
      throw new TypeError(`Unresolved or misplaced policy path binding: ${value}`);
    }
    const bound = bindings[name];
    validate(bound, { type: "string", minLength: 1, format: "path" }, `bindings.${name}`);
    if (typeof bound !== "string" || /[?*{}]/.test(bound)) {
      throw new TypeError(`Binding ${name} must be a literal repository path`);
    }
    used.add(name);
    const result = value.replace(`\${${name}}`, normalize(bound));
    return shape.format === "path" ? normalize(result) : result;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => bindPaths(item, shape?.items, bindings, validate, used));
  }
  if (plain(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        bindPaths(
          item,
          shape?.properties?.[key] ??
            (typeof shape?.additionalProperties === "object"
              ? shape.additionalProperties
              : undefined),
          bindings,
          validate,
          used,
        ),
      ]),
    );
  }
  return value;
}

function provenance(
  value: unknown,
  source: Omit<PolicyOrigin, "pointer">,
  pointer = "",
  output: Origins = {},
): Origins {
  output[pointer] = [{ ...source, pointer }];
  if (isRecord(value) || isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      provenance(item, source, `${pointer}/${escape(key)}`, output);
    }
  }
  return output;
}

function compose(left: Resolved, right: Resolved): Resolved {
  const origins = clone(left.origins);
  const combine = (destination: string, source = destination): void => {
    for (const [path, entries] of Object.entries(right.origins)) {
      if (path !== source && !path.startsWith(`${source}/`)) {
        continue;
      }
      const key = destination + path.slice(source.length);
      origins[key] = [
        ...new Map(
          [...(origins[key] ?? []), ...entries].map((entry) => [canonical(entry), entry]),
        ).values(),
      ];
    }
  };
  const nodeOrigin = (path: string): void => {
    origins[path] = [
      ...new Map(
        [...(origins[path] ?? []), ...(right.origins[path] ?? [])].map((entry) => [
          canonical(entry),
          entry,
        ]),
      ).values(),
    ];
  };
  const addition = (value: unknown, path: string): void => {
    if (
      path.startsWith("/javascript/") &&
      !["/javascript/rules", "/javascript/syntax", "/javascript/clientDirective"].some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      )
    ) {
      throw new TypeError(`An overlay cannot reconfigure ${path}`);
    }
    if (Array.isArray(value)) {
      if (value.length && !isAdditive(path)) {
        throw new TypeError(
          `An overlay cannot add or widen ${path}; update the pinned bundle instead`,
        );
      }
    } else if (plain(value)) {
      for (const [key, item] of Object.entries(value)) {
        addition(item, `${path}/${escape(key)}`);
      }
    } else if (allowances.has(path) || path === "/javascript/tailwind") {
      throw new TypeError(`An overlay cannot reconfigure ${path}`);
    }
  };
  const merge = (before: unknown, after: unknown, path = ""): unknown => {
    if (canonical(before) === canonical(after)) {
      combine(path);
      return clone(before);
    }
    nodeOrigin(path);
    if (isArray(before) && isArray(after)) {
      if (!isAdditive(path)) {
        throw new TypeError(
          `Conflicting policy values at ${path}; imported allowances cannot be changed by an overlay`,
        );
      }
      const result: unknown[] = clone(before);
      for (const [index, item] of after.entries()) {
        let target = result.findIndex((entry) => canonical(entry) === canonical(item));
        if (target < 0) {
          if (path === "/projects") {
            const family = (profile: unknown): unknown =>
              profile === "typescript" || profile === "react" ? "javascript" : profile;
            const root = (entry: unknown): string => normalize(String(field(entry, "root")));
            if (
              result.some(
                (entry) =>
                  family(field(entry, "profile")) === family(field(item, "profile")) &&
                  (isWithin(root(entry), root(item)) || isWithin(root(item), root(entry))),
              )
            ) {
              throw new TypeError(
                `Conflicting or overlapping imported project owner: ${root(item)}`,
              );
            }
          }
          const id = field(item, "id");
          if (path === "/verification" && result.some((entry) => field(entry, "id") === id)) {
            throw new TypeError(`Conflicting verification suite: ${String(id)}`);
          }
          target = result.length;
          result.push(clone(item));
        }
        combine(`${path}/${target}`, `${path}/${index}`);
      }
      return result;
    }
    if (plain(before) && plain(after)) {
      const result: Record<string, unknown> = clone(before);
      for (const [key, item] of Object.entries(after)) {
        const next = `${path}/${escape(key)}`;
        if (Object.hasOwn(before, key)) {
          result[key] = merge(before[key], item, next);
        } else {
          addition(item, next);
          result[key] = clone(item);
          combine(next);
        }
      }
      return result;
    }
    if (path === "/preset" && before === "portable" && after === "ozmikhail") {
      combine(path);
      return after;
    }
    throw new TypeError(
      `Conflicting policy values at ${path || "/"}; overlays cannot override imported values`,
    );
  };
  return { value: merge(left.value, right.value), origins };
}

// resolution is explicit and offline. Imported files are checked before their data is used.
export function resolvePolicy(
  path: string,
  source: string | Uint8Array | undefined,
  { schema, validate }: { schema: Shape; validate: Validate },
): Resolved & { inputs: PolicyInput[] } {
  const stack = new Set<string>(),
    inputs = new Map<string, string>();
  let visits = 0;
  const visit = (
    file: string,
    contents: string | Uint8Array,
    bindings: Record<string, unknown> = {},
    expected?: string,
  ): Resolved => {
    if (++visits > 128 || stack.size >= 32) {
      throw new TypeError("Policy bundle graph exceeds its supported size");
    }
    if (stack.has(file)) {
      throw new TypeError(`Policy bundle cycle at ${file}`);
    }
    const sha256 = digest(contents);
    if (expected && sha256 !== expected) {
      throw new TypeError(`Policy bundle hash mismatch: ${file}`);
    }
    if (inputs.has(file) && inputs.get(file) !== sha256) {
      throw new TypeError(`Policy bundle changed during resolution: ${file}`);
    }
    inputs.set(file, sha256);
    stack.add(file);
    try {
      const raw: unknown = JSON.parse(
          typeof contents === "string"
            ? contents
            : new TextDecoder("utf-8", { fatal: true }).decode(contents),
        ),
        used = new Set<string>();
      const bindingShape: Shape = {
        ...schema,
        properties: {
          ...schema.properties,
          bundles: { type: "array", items: BUNDLE_REFERENCE_SCHEMA },
        },
      };
      const parsed = bindPaths(raw, bindingShape, bindings, validate, used);
      for (const name of Object.keys(bindings)) {
        if (!used.has(name)) {
          throw new TypeError(`Unused policy path binding: ${name}`);
        }
      }
      if (!plain(parsed)) {
        throw new TypeError(`${file}: the policy must be an object`);
      }
      const references = parsed.bundles ?? [];
      const referenceShape = {
        type: "array",
        items: BUNDLE_REFERENCE_SCHEMA,
        uniqueItems: true,
      } as const;
      validateSchema(references, referenceShape, "bundles");
      const value = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "bundles"));
      validate(value, schema, file);
      let inherited: Resolved | undefined;
      for (const reference of references) {
        const target = localFile(reference.path, dirname(file));
        const resolved = visit(target, readFileSync(target), reference.bindings, reference.sha256);
        inherited = inherited ? compose(inherited, resolved) : resolved;
      }
      const own = {
        value: references.length ? value : { preset: "ozmikhail", ...value },
        origins: provenance(value, { path: file, sha256 }),
      };
      if (!references.length && !Object.hasOwn(value, "preset")) {
        own.origins["/preset"] = [{ path: file, pointer: "", sha256, default: true }];
      }
      const result = inherited ? compose(inherited, own) : own;
      validate(result.value, schema, file);
      return result;
    } finally {
      stack.delete(file);
    }
  };
  const root = localFile(resolve(path), dirname(resolve(path)));
  const result = visit(root, source ?? readFileSync(root));
  return {
    ...result,
    inputs: [...inputs].sort(([a], [b]) => order(a, b)).map(([path, sha256]) => ({ path, sha256 })),
  };
}

interface PolicyView {
  value: unknown;
  origins?: Origins;
}

export function diffPolicies(before: PolicyView, after: PolicyView): PolicyChange[] {
  const result: PolicyChange[] = [],
    absent = Symbol("absent");
  const walk = (left: unknown, right: unknown, path = ""): void => {
    if (left !== absent && right !== absent && canonical(left) === canonical(right)) {
      return;
    }
    if (left !== absent && right !== absent && plain(left) && plain(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(order)) {
        walk(
          Object.hasOwn(left, key) ? left[key] : absent,
          Object.hasOwn(right, key) ? right[key] : absent,
          `${path}/${escape(key)}`,
        );
      }
      return;
    }
    result.push({
      path: path || "/",
      kind: left === absent ? "added" : right === absent ? "removed" : "changed",
      ...(left !== absent ? { before: clone(left) } : {}),
      ...(right !== absent ? { after: clone(right) } : {}),
      ...(before.origins?.[path] ? { beforeOrigins: before.origins[path] } : {}),
      ...(after.origins?.[path] ? { afterOrigins: after.origins[path] } : {}),
    });
  };
  walk(before.value, after.value);
  return result;
}
