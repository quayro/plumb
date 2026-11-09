import { canonical, globMatches, normalize } from "./files.ts";

// the subset of JSON Schema the policy uses; Infer turns a shape into the type it validates
export interface Shape {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly type?: "object" | "array" | "string" | "boolean" | "integer";
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, Shape>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Shape;
  readonly items?: Shape;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly pattern?: string;
  readonly format?: "path" | "glob" | "regex";
  readonly minimum?: number;
  readonly maximum?: number;
}

type Flatten<T> = { [K in keyof T]: T[K] } & {};

type Members<P, R> = Flatten<
  { -readonly [K in keyof P as K extends R ? K : never]: Infer<P[K]> } & {
    -readonly [K in keyof P as K extends R ? never : K]?: Infer<P[K]>;
  }
>;

export type Infer<S> = S extends { const: infer C }
  ? C
  : S extends { enum: readonly (infer E)[] }
    ? E
    : S extends { type: "string" }
      ? string
      : S extends { type: "boolean" }
        ? boolean
        : S extends { type: "integer" }
          ? number
          : S extends { type: "array"; items: infer I }
            ? Infer<I>[]
            : S extends { type: "object"; properties: infer P; required: readonly (infer R)[] }
              ? Members<P, R>
              : S extends { type: "object"; properties: infer P }
                ? Members<P, never>
                : S extends { type: "object"; additionalProperties: infer A extends Shape }
                  ? Record<string, Infer<A>>
                  : S extends { type: "object" }
                    ? Record<string, unknown>
                    : unknown;

export interface ArrayShape<I extends Shape> {
  readonly type: "array";
  readonly items: I;
  readonly minItems: number;
  readonly uniqueItems: true;
}

interface ObjectShape<P extends Record<string, Shape>, R extends readonly string[]> {
  readonly type: "object";
  readonly properties: P;
  readonly required: R;
  readonly additionalProperties: false;
}

export const array = <const I extends Shape>(items: I, minItems = 0): ArrayShape<I> => ({
  type: "array",
  items,
  minItems,
  uniqueItems: true,
});

export function object<const P extends Record<string, Shape>>(properties: P): ObjectShape<P, []>;

export function object<
  const P extends Record<string, Shape>,
  const R extends readonly (keyof P & string)[],
>(properties: P, required: R): ObjectShape<P, R>;

export function object(
  properties: Record<string, Shape>,
  required: readonly string[] = [],
): ObjectShape<Record<string, Shape>, readonly string[]> {
  return { type: "object", properties, required, additionalProperties: false };
}

// Array.isArray answers any[]; untrusted JSON stays unknown until each item is checked
export const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// reads a nested value from untrusted JSON; any missing step yields undefined
export const at = (value: unknown, ...keys: (string | number)[]): unknown =>
  keys.reduce<unknown>(
    (current, key) =>
      typeof key === "number"
        ? isArray(current)
          ? current[key]
          : undefined
        : isRecord(current)
          ? current[key]
          : undefined,
    value,
  );

export function validateSchema<const S extends Shape>(
  value: unknown,
  shape: S,
  at = "config",
): asserts value is Infer<S> {
  const bad = (message: string): never => {
    throw new TypeError(`${at}: ${message}`);
  };
  if (Object.hasOwn(shape, "const") && value !== shape.const) {
    bad(`must equal ${String(shape.const)}`);
  }
  if (shape.enum && !shape.enum.includes(value)) {
    bad(`must be one of ${shape.enum.join(", ")}`);
  }
  if (shape.type === "object") {
    if (!isRecord(value)) {
      return bad("must be an object");
    }
    for (const required of shape.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        bad(`missing ${required}`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        bad(`unsupported key ${key}`);
      }
      const sub =
        shape.properties?.[key] ??
        (typeof shape.additionalProperties === "object" ? shape.additionalProperties : null);
      if (sub) {
        validateSchema<Shape>(item, sub, `${at}.${key}`);
      } else if (shape.additionalProperties === false) {
        bad(`unknown key ${key}`);
      }
    }
  } else if (shape.type === "array") {
    if (!Array.isArray(value) || value.length < (shape.minItems ?? 0)) {
      return bad(`must be an array with at least ${shape.minItems ?? 0} entries`);
    }
    const items: unknown[] = value;
    if (shape.uniqueItems && new Set(items.map((item) => canonical(item))).size !== items.length) {
      bad("contains duplicate entries");
    }
    const itemShape: Shape = shape.items ?? {};
    items.forEach((item, index) => {
      validateSchema<Shape>(item, itemShape, `${at}[${index}]`);
    });
  } else if (shape.type === "string") {
    if (
      typeof value !== "string" ||
      value.length < (shape.minLength ?? 0) ||
      value.includes("\0")
    ) {
      return bad("must be a valid string");
    }
    if (shape.pattern && !new RegExp(shape.pattern).test(value)) {
      bad(`must match ${shape.pattern}`);
    }
    if (shape.format === "regex") {
      try {
        new RegExp(value);
      } catch {
        bad("invalid regular expression");
      }
    }
    if (shape.format === "glob") {
      try {
        globMatches(value, "probe");
      } catch (error) {
        bad(error instanceof Error ? error.message : String(error));
      }
    }
    if (
      shape.format === "path" &&
      (/^(?:[a-z]:|\/)/i.test(normalize(value)) ||
        normalize(value)
          .split("/")
          .some((part) => ["..", ".git", ".hg", ".svn", "node_modules"].includes(part)))
    ) {
      bad(
        "must stay inside the repository and outside reserved metadata or dependency directories",
      );
    }
  } else if (shape.type === "boolean" && typeof value !== "boolean") {
    bad("must be a boolean");
  } else if (
    shape.type === "integer" &&
    (typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < (shape.minimum ?? 0) ||
      value > (shape.maximum ?? Infinity))
  ) {
    bad("integer is outside its supported range");
  }
}
