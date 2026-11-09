import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BUNDLE_REFERENCE_SCHEMA, type PolicyInput, resolvePolicy } from "./bundles.ts";
import { CONVENTIONS_SCHEMA } from "./convention-schema.ts";
import { validateConventions } from "./conventions.ts";
import type { Origins } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { normalize, safePath } from "./files.ts";
import { POLICY_TESTS_SCHEMA, validatePolicyTests } from "./policy-tests.ts";
import { array, type Infer, object, type Shape, validateSchema } from "./schema.ts";

export { validateSchema } from "./schema.ts";

const text = { type: "string", minLength: 1 } as const;
const reason = { ...text, pattern: "\\S" } as const;
const bool = { type: "boolean" } as const;
const integer = { type: "integer", minimum: 1 } as const;

const strings = array(text, 1);

const path = { ...text, format: "path" } as const;
const glob = { ...text, format: "glob" } as const;
const globs = array(glob, 1);
const regex = { ...text, format: "regex" } as const;
const exempt = object({ path, reason }, ["path", "reason"]);
const project = object(
  {
    root: path,
    profile: { ...text, pattern: "^[a-z][a-z0-9-]*$" },
    options: { type: "object" },
    tsconfigs: array(path, 1),
    knip: bool,
    surface: object(
      { snapshot: { ...path, pattern: "\\.surface\\.json$" }, tsconfig: path, signatures: bool },
      ["snapshot"],
    ),
    uniqueExports: array(path, 1),
    javascript: { type: "object" },
    compileCommands: path,
    prepare: array(array(text, 1), 1),
  },
  ["root", "profile"],
);
const contracts = object({
  boundaries: array(object({ from: globs, deny: globs, reason }, ["from", "deny", "reason"])),
  manifests: array(
    object({ file: path, variable: text, entry: text, exempt: array(exempt) }, [
      "file",
      "variable",
      "entry",
    ]),
  ),
  registrations: array(
    object(
      {
        sources: path,
        call: object({ name: text, from: path }, ["name", "from"]),
        registrar: object({ files: glob, suffix: text }, ["files", "suffix"]),
        composition: object({ file: path, function: text }, ["file", "function"]),
      },
      ["sources", "call", "registrar", "composition"],
    ),
  ),
  lazyModules: array(
    object(
      {
        loader: path,
        listing: object({ file: path, pattern: regex, root: path }, ["file", "pattern", "root"]),
        names: object({ files: glob, pattern: regex }, ["files", "pattern"]),
      },
      ["loader", "names"],
    ),
  ),
  writtenOnce: array(
    object({ table: path, values: regex, files: globs, ignore: globs }, [
      "table",
      "values",
      "files",
    ]),
  ),
  importGraphs: array(
    object(
      {
        entries: globs,
        within: path,
        refuse: object({ packages: regex, specifiers: regex, extensions: strings }),
        reason,
      },
      ["entries", "within", "refuse", "reason"],
    ),
  ),
});

export const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:plumb:policy:v1",
  title: "Plumb policy",
  ...object(
    {
      $schema: text,
      schemaVersion: { const: 1 },
      preset: { enum: ["ozmikhail", "portable"] },
      projects: array(project),
      bundles: array(BUNDLE_REFERENCE_SCHEMA, 1),
      exclude: array(object({ files: globs, reason }, ["files", "reason"])),
      files: object({
        required: array(path),
        forbidden: globs,
        names: array(
          object({ files: globs, pattern: regex, reason }, ["files", "pattern", "reason"]),
        ),
        maxLines: integer,
      }),
      docs: object({
        index: path,
        root: path,
        sections: array({ ...text, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }, 1),
        kinds: array(
          object(
            {
              files: globs,
              exclude: globs,
              name: regex,
              sections: strings,
              status: strings,
              sequence: bool,
            },
            ["files"],
          ),
        ),
        generated: array(
          object(
            {
              file: path,
              region: { ...text, pattern: "^[a-z][a-z0-9-]*$" },
              command: { type: "array", items: text, minItems: 1 },
            },
            ["file", "region", "command"],
          ),
        ),
      }),
      comments: object({ tasks: regex }),
      generated: array(
        object({ path, content: { type: "string" }, executable: bool }, ["path", "content"]),
      ),
      format: object({
        ignore: array(object({ path: glob, reason }, ["path", "reason"])),
        keyColumns: array(glob),
        sortKeys: array(object({ files: globs, depth: integer }, ["files"])),
        tools: array(
          object(
            {
              tool: { type: "string", enum: ["prisma", "shfmt", "sql-formatter", "taplo"] },
              files: globs,
              dialect: text,
            },
            ["tool", "files"],
          ),
        ),
      }),
      contracts,
      conventions: CONVENTIONS_SCHEMA,
      policyTests: POLICY_TESTS_SCHEMA,
      javascript: { type: "object" },
      exceptions: array(
        object(
          {
            id: { ...text, pattern: "^[a-z][a-z0-9-]*$" },
            rules: strings,
            files: globs,
            reason,
            max: integer,
            expires: { ...text, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          ["id", "rules", "files", "reason", "max"],
        ),
      ),
      policy: object({
        protected: globs,
        owners: array(
          { type: "string", pattern: "^@[A-Za-z0-9-]+(/[A-Za-z0-9._-]+)?$|^[^@\\s]+@[^@\\s]+$" },
          1,
        ),
      }),
      commits: object({
        types: array({ ...text, pattern: "^[a-z]+$" }, 1),
        scopes: array({ ...text, pattern: "^[a-z][a-z0-9-]*$" }, 1),
        maxLength: integer,
      }),
      hooks: object({ command: array(text, 1), path }, ["command"]),
      tools: object({
        timeout: { ...integer, maximum: 3600000 },
        versions: { type: "object", additionalProperties: text },
      }),
      verification: array(
        object(
          {
            id: { ...text, pattern: "^[a-z][a-z0-9-]*$" },
            command: array(text, 1),
            cwd: path,
            format: { enum: ["junit", "plumb-json"] },
            report: { enum: ["stdout", "file"] },
            minTests: integer,
            maxSkipped: { type: "integer", minimum: 0 },
            timeout: { ...integer, maximum: 3600000 },
            env: { type: "object", additionalProperties: { type: "string" } },
            inheritEnv: array({ ...text, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
          },
          ["id", "command", "format"],
        ),
      ),
    },
    ["schemaVersion"],
  ),
};

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach((item: unknown) => freeze(item));
    Object.freeze(value);
  }
  return value;
}

function normalizePaths(value: unknown, shape: Shape): unknown {
  if (shape.format === "path" && typeof value === "string") {
    return normalize(value);
  }
  const { items, properties } = shape;
  if (Array.isArray(value) && items) {
    return value.map((item: unknown) => normalizePaths(item, items));
  }
  if (value && typeof value === "object" && properties) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => {
        const sub = properties[key];
        return [key, sub ? normalizePaths(item, sub) : item];
      }),
    );
  }
  return value;
}

type Policy = Infer<typeof schema>;

export type Config = Policy &
  Required<Pick<Policy, "preset" | "projects" | "exclude" | "exceptions">>;

export type Project = Config["projects"][number];

export interface LoadedConfig {
  config: Config;
  source: string;
  path: string;
  origins: Origins;
  policyInputs: PolicyInput[];
}

export function definePlumb(input: unknown): Config {
  validateSchema(input, schema);
  if (Object.hasOwn(input, "bundles")) {
    throw new TypeError(
      "Resolve pinned bundles with loadConfig before defining the effective policy",
    );
  }
  // normalizing paths keeps the validated shape; validating again proves it to the compiler
  const normalized = normalizePaths(input, schema);
  validateSchema(normalized, schema);
  const config: Config = structuredClone({
    preset: "ozmikhail",
    projects: [],
    exclude: [],
    exceptions: [],
    ...normalized,
  });
  validatePolicyTests(config.policyTests);
  validateConventions(config.conventions);
  const roots = new Set<string>();
  for (const project of config.projects) {
    project.root = normalize(project.root);
    const key = `${project.root}:${["typescript", "react"].includes(project.profile) ? "javascript" : project.profile}`;
    if (roots.has(key)) {
      throw new TypeError(`Duplicate project ${key}`);
    }
    roots.add(key);
    if (project.profile === "cpp" && !project.compileCommands) {
      throw new TypeError(`projects ${project.root}: cpp requires compileCommands`);
    }
    if (
      !["typescript", "react"].includes(project.profile) &&
      ["tsconfigs", "knip", "surface", "uniqueExports", "javascript"].some((key) => key in project)
    ) {
      throw new TypeError(
        `projects ${project.root}: JavaScript options require a typescript or react profile`,
      );
    }
  }
  const ids = new Set<string>();
  for (const suite of config.verification ?? []) {
    if (ids.has(suite.id)) {
      throw new TypeError(`Duplicate verification suite ${suite.id}`);
    }
    ids.add(suite.id);
  }
  ids.clear();
  for (const exception of config.exceptions) {
    if (ids.has(exception.id)) {
      throw new TypeError(`Duplicate exception id ${exception.id}`);
    }
    ids.add(exception.id);
    if (
      exception.expires &&
      (!Number.isFinite(Date.parse(exception.expires)) ||
        new Date(exception.expires).toISOString().slice(0, 10) !== exception.expires)
    ) {
      throw new TypeError(`Exception ${exception.id}: invalid expiry date`);
    }
  }
  for (const [index, entry] of (config.format?.tools ?? []).entries()) {
    if (entry.dialect && entry.tool !== "sql-formatter") {
      throw new TypeError(`format.tools[${index}].dialect: only sql-formatter takes a dialect`);
    }
  }
  for (const generated of config.generated ?? []) {
    if (generated.path === "plumb.json" || generated.path.endsWith(".surface.json")) {
      throw new TypeError(
        `generated ${generated.path}: sync cannot replace policy or API expectations`,
      );
    }
  }
  return freeze(config);
}

export function loadConfig(root: string, file = "plumb.json", policy?: string): LoadedConfig {
  const path = policy ? resolve(policy) : safePath(root, file);
  let source: string, bytes: Buffer;
  try {
    bytes = readFileSync(path);
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Cannot read UTF-8 policy ${path}: ${errorMessage(error)}`, { cause: error });
  }
  let resolved: ReturnType<typeof resolvePolicy>;
  try {
    resolved = resolvePolicy(path, bytes, { schema, validate: validateSchema });
  } catch (error) {
    throw new TypeError(`${path}: ${errorMessage(error)}`, { cause: error });
  }
  return {
    config: definePlumb(resolved.value),
    source,
    path,
    origins: resolved.origins,
    policyInputs: resolved.inputs,
  };
}
