import { array, type ArrayShape, type Infer, object } from "./schema.ts";

export const text = { type: "string", minLength: 1 } as const;

const id = { ...text, pattern: "^[a-z][a-z0-9-]*$" } as const;

const bool = { type: "boolean" } as const;

const integer = { type: "integer", minimum: 0 } as const;

export const path = { ...text, format: "path" } as const;

const regex = { ...text, format: "regex" } as const;

const glob = { ...text, format: "glob" } as const;

const globs = (minimum = 1): ArrayShape<typeof glob> => array(glob, minimum);

const names = (minimum = 0): ArrayShape<typeof text> => array(text, minimum);

const template = object({ path, content: { type: "string" } }, ["path", "content"]);

const kinds = [
  "function",
  "class",
  "interface",
  "type",
  "variable",
  "method",
  "property",
  "constructor",
];

export const CONVENTIONS_SCHEMA = object(
  {
    files: globs(),
    roles: array(
      object(
        {
          id,
          files: globs(),
          name: regex,
          imports: object({ allow: globs(0), deny: globs(0) }),
          exports: object({ require: names(), allow: names(), name: regex }),
          companions: array(object({ path, role: id }, ["path"]), 1),
          javascript: object({
            nodes: array(
              object(
                {
                  id,
                  select: object(
                    {
                      kinds: array({ enum: kinds }, 1),
                      names: names(1),
                      exported: bool,
                      topLevel: bool,
                    },
                    ["kinds"],
                  ),
                  count: object({ min: integer, max: integer }),
                },
                ["id", "select", "count"],
              ),
              1,
            ),
            assignable: array(
              object(
                {
                  id,
                  export: text,
                  contract: object({ file: path, symbol: text }, ["file", "symbol"]),
                  tsconfig: path,
                },
                ["id", "export", "contract", "tsconfig"],
              ),
              1,
            ),
            budgets: object({
              functionLines: { ...integer, minimum: 1 },
              maxParameters: integer,
              maxNesting: integer,
              duplicateBlocks: object(
                {
                  minStatements: { ...integer, minimum: 2 },
                  maxCopies: { ...integer, minimum: 1 },
                },
                ["minStatements", "maxCopies"],
              ),
            }),
          }),
          scaffold: object(
            { ...template.properties, companions: array(template, 1) },
            template.required,
          ),
        },
        ["id", "files"],
      ),
      1,
    ),
  },
  ["files", "roles"],
);

export type Conventions = Infer<typeof CONVENTIONS_SCHEMA>;
