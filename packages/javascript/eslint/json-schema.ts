import { globMatches } from "../shared/glob.ts";

export type JsonSchema =
  | boolean
  | {
      type?: "string" | "boolean" | "number" | "array" | "object";
      const?: unknown;
      enum?: readonly unknown[];
      anyOf?: readonly JsonSchema[];
      properties?: Readonly<Record<string, JsonSchema>>;
      required?: readonly string[];
      additionalProperties?: JsonSchema;
      minProperties?: number;
      items?: JsonSchema | readonly JsonSchema[];
      minItems?: number;
      maxItems?: number;
      minLength?: number;
      pattern?: string;
      format?: "regex" | "glob";
      minimum?: number;
    };

type Flatten<T> = { [K in keyof T]: T[K] } & {};

type Tuple<T> = { -readonly [K in keyof T]: FromSchema<T[K]> };

// the value a schema accepts; anyOf only narrows an object shape, so it adds no fields here
export type FromSchema<S> = S extends { const: infer C }
  ? C
  : S extends { enum: readonly (infer E)[] }
    ? E
    : S extends { type: "string" }
      ? string
      : S extends { type: "boolean" }
        ? boolean
        : S extends { type: "number" }
          ? number
          : S extends {
                type: "array";
                items: infer T extends readonly [unknown, ...unknown[]];
              }
            ? Tuple<T>
            : S extends { type: "array"; items: infer I }
              ? FromSchema<I>[]
              : S extends {
                    type: "object";
                    properties: infer P;
                    required: readonly (infer R)[];
                  }
                ? Flatten<
                    { [K in keyof P & R]: FromSchema<P[K]> } & {
                      [K in Exclude<keyof P, R>]?: FromSchema<P[K]>;
                    }
                  >
                : S extends { type: "object"; additionalProperties: infer A }
                  ? Record<string, A extends true ? unknown : FromSchema<A>>
                  : unknown;

export const text = { type: "string", minLength: 1 } as const;

export const flag = { type: "boolean" } as const;

export const list = <const I extends JsonSchema>(items: I, minItems = 0) =>
  ({ type: "array", items, minItems }) as const;

export const object = <
  const P extends Readonly<Record<string, JsonSchema>>,
  const R extends readonly (keyof P & string)[] = readonly [],
>(
  properties: P,
  required?: R,
) =>
  ({
    type: "object",
    properties,
    required: required ?? ([] as const),
    additionalProperties: false,
  }) as const;

// ESLint's validator does not register Plumb's path formats; the policy validator checks those
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkSchema = (value: unknown, schema: JsonSchema, location = "javascript"): void => {
  const fail = (detail: string): never => {
    throw new TypeError(`${location}: ${detail}`);
  };
  if (schema === true) {
    return;
  }
  if (schema === false) {
    return fail("is not supported");
  }
  if (schema.const !== undefined && value !== schema.const) {
    fail(`must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    fail(`must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  if (
    schema.anyOf &&
    !schema.anyOf.some((choice) => {
      try {
        checkSchema(value, choice, location);
        return true;
      } catch {
        return false;
      }
    })
  ) {
    fail("does not match any allowed shape");
  }
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && kind !== schema.type) {
    fail(`must be ${schema.type}`);
  }
  if (isObject(value) && schema.type === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("must be a plain object");
    }
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) {
      fail("must not be empty");
    }
    for (const [key, entry] of Object.entries(value)) {
      const child =
        schema.properties && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : schema.additionalProperties;
      if (!child) {
        return fail(`unknown option ${key}`);
      }
      checkSchema(entry, child, `${location}.${key}`);
    }
  }
  if (schema.required) {
    for (const key of schema.required) {
      if (!isObject(value) || !Object.hasOwn(value, key)) {
        fail(`requires ${key}`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`requires at least ${schema.minItems} entries`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`allows at most ${schema.maxItems} entries`);
    }
    const { items } = schema;
    if (items !== undefined) {
      value.forEach((entry: unknown, index) =>
        checkSchema(
          entry,
          isTuple(items) ? (items[index] ?? false) : items,
          `${location}[${index}]`,
        ),
      );
    }
  }
  if (typeof value === "string") {
    if (schema.minLength && value.trim().length < schema.minLength) {
      fail("must be a nonempty string");
    }
    if (value.includes("\0")) {
      fail("must not contain a NUL character");
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      fail(`must match ${schema.pattern}`);
    }
    if (schema.format === "regex") {
      try {
        new RegExp(value);
      } catch {
        fail("must be a valid regular expression");
      }
    }
    if (schema.format === "glob") {
      try {
        globMatches(value, "probe");
      } catch {
        fail("must be a supported project-relative glob");
      }
    }
  }
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum))
  ) {
    fail(`must be a finite number at least ${schema.minimum ?? 0}`);
  }
};

const isTuple = (items: JsonSchema | readonly JsonSchema[]): items is readonly JsonSchema[] =>
  Array.isArray(items);

// the value passed every constraint of its schema, so it has the shape the schema describes
export function validateSchema<const S extends JsonSchema>(
  value: unknown,
  schema: S,
  location?: string,
): asserts value is FromSchema<S> {
  checkSchema(value, schema, location);
}
