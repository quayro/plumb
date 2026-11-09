import { isRequireCall } from "../shared/edges.ts";
import { globMatches } from "../shared/glob.ts";
import { effectOrigins, isReflectiveRead, isValueReference, type Origin } from "./effects.ts";
import { eslintRuleSchema, type RuleOptions } from "./options.ts";
import { rulesRelativeTo } from "./rules/shared.ts";
import { type Node, plumbSettings, type RuleModule, type TSESTree } from "./types.ts";

type Row = RuleOptions<"plumb/owners">["rows"][number];

type Part = string | number | undefined;

type Match = boolean | "unresolved";

const importsFrom = (row: Row, source: string): boolean =>
  row.importFrom === source || (row.name === "*" && source.startsWith(`${row.importFrom}/`));

const host = (origin: Origin): Part[] => {
  let name: Part = origin.global ?? origin.module?.replace(/^node:/, ""),
    path: Part[] = origin.path;
  if (origin.module && path[0] === "default") {
    path = path.slice(1);
  }
  if (
    origin.global &&
    typeof name === "string" &&
    ["window", "globalThis", "self"].includes(name) &&
    path.length
  ) {
    name = path[0];
    path = path.slice(1);
  }
  return [name, ...path];
};

const prefix = (actual: readonly Part[], expected: readonly Part[]): boolean =>
  actual.length >= expected.length &&
  expected.every((part, index) => actual[index] === part || actual[index] === undefined);

export const ownersRule: RuleModule<[Partial<RuleOptions<"plumb/owners">>?]> = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/owners"),
    messages: {
      owner: "{{message}}",
      unresolved:
        "Cannot establish ownership through a computed or reassigned governed reference. {{message}}",
    },
  },
  create(context) {
    const { root = context.cwd, rows = [] } = context.options[0] ?? {};
    const file = rulesRelativeTo(root, context.filename),
      live = rows.filter((row) => !globMatches(row.owner, file));
    if (!live.length) {
      return {};
    }
    const effects = effectOrigins(context),
      reported = new WeakMap<Node, Set<Row>>();
    const report = (node: Node, row: Row, incomplete = false): void => {
      let seen = reported.get(node);
      if (!seen) {
        seen = new Set();
        reported.set(node, seen);
      }
      if (seen.has(row)) {
        return;
      }
      seen.add(row);
      context.report({
        node,
        messageId: incomplete ? "unresolved" : "owner",
        data: { message: row.message },
      });
    };
    const match = (row: Row, origin: Origin, construction = false): Match => {
      if (origin.container?.length || origin.caught) {
        return false;
      }
      if (origin.unknownModule) {
        return row.importFrom ? "unresolved" : false;
      }
      const actual = host(origin),
        [head] = actual,
        requested =
          row.member && typeof head === "string" && head && row.member.startsWith(`${head}.`)
            ? [head, ...row.member.slice(head.length + 1).split(".")]
            : row.member?.split(".");
      let found = requested && !origin.meta && prefix(actual, requested);
      if (row.global && origin.global) {
        found ||= prefix(actual, [row.global]);
      }
      if (row.now && !origin.meta) {
        found ||=
          prefix(actual, ["Date", "now"]) ||
          (construction && actual.length === 1 && (head === "Date" || head === undefined));
      }
      if (construction && row.construct && origin.global) {
        found ||=
          actual.length === 1 &&
          (head === undefined || (typeof head === "string" && row.construct.includes(head)));
      }
      if (row.meta && origin.meta) {
        found ||=
          origin.path[0] === row.meta || (origin.path[0] === undefined && origin.path.length > 0);
      }
      if (row.importFrom && origin.module && importsFrom(row, origin.module)) {
        found ||=
          row.name === "*" ||
          !origin.path.length ||
          origin.path[0] === row.name ||
          origin.path[0] === undefined;
      }
      return found
        ? origin.uncertain || actual.some((part) => part === undefined)
          ? "unresolved"
          : true
        : false;
    };
    const inspect = (node: Node, { construction = false, clock = false } = {}): void => {
      const origins = effects.origins(node);
      for (const row of live) {
        const matches = origins.map((origin) =>
          match(clock || !row.now ? row : { ...row, now: undefined }, origin, construction),
        );
        let result: Match = matches.includes(true)
          ? true
          : matches.includes("unresolved")
            ? "unresolved"
            : false;
        if (
          !result &&
          row.importFrom &&
          row.name !== undefined &&
          plumbSettings(context).plumbTyped?.matches(context, node, {
            from: row.importFrom,
            name: row.name,
          }) === true
        ) {
          result = true;
        }
        if (result) {
          report(node, row, result === "unresolved");
        }
      }
    };
    const bindings = (pattern: Node | null | undefined): TSESTree.Identifier[] => {
      if (!pattern) {
        return [];
      }
      // every other node binds no name
      if (pattern.type === "Identifier") {
        return [pattern];
      }
      if (pattern.type === "RestElement") {
        return bindings(pattern.argument);
      }
      if (pattern.type === "AssignmentPattern") {
        return bindings(pattern.left);
      }
      if (pattern.type === "ObjectPattern") {
        return pattern.properties.flatMap((item) =>
          bindings(item.type === "Property" ? item.value : item),
        );
      }
      return pattern.type === "ArrayPattern"
        ? pattern.elements.flatMap((item) => bindings(item))
        : [];
    };
    return {
      Identifier(node) {
        if (isValueReference(node)) {
          inspect(node, { clock: true });
        }
      },
      MemberExpression(node) {
        inspect(node, { clock: true });
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") {
          for (const name of bindings(node.id)) {
            inspect(name, { clock: true });
          }
        }
      },
      ImportDeclaration(node) {
        if (node.importKind === "type") {
          return;
        }
        if (!node.specifiers.length) {
          for (const row of live) {
            if (row.importFrom && row.name === "*" && importsFrom(row, node.source.value)) {
              report(node, row);
            }
          }
        }
        for (const imported of node.specifiers) {
          if (imported.type !== "ImportSpecifier" || imported.importKind !== "type") {
            inspect(imported.local, { clock: true });
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.exportKind === "type") {
            continue;
          }
          inspect(specifier.local, { clock: true });
          if (!node.source) {
            continue;
          }
          for (const row of live) {
            if (
              row.importFrom &&
              importsFrom(row, node.source.value) &&
              (row.name === "*" ||
                (specifier.local.type === "Identifier"
                  ? specifier.local.name
                  : specifier.local.value) === row.name)
            ) {
              report(specifier, row);
            }
          }
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") {
          return;
        }
        for (const row of live) {
          if (row.importFrom && importsFrom(row, node.source.value)) {
            report(node, row);
          }
        }
      },
      CallExpression(node) {
        if (isRequireCall(context, node) || isReflectiveRead(context, node)) {
          inspect(node, { clock: true });
        }
      },
      ImportExpression(node) {
        const source = effects.literal(node.source);
        for (const row of live) {
          if (
            row.dynamicImport ||
            (row.importFrom && source !== undefined && importsFrom(row, source))
          ) {
            report(node, row);
          } else if (row.importFrom && source === undefined) {
            report(node, row, true);
          }
        }
      },
      NewExpression(node) {
        inspect(node.callee, {
          construction: true,
          clock: node.arguments.length === 0,
        });
      },
      JSXAttribute(node) {
        for (const row of live) {
          if (
            node.name.type === "JSXIdentifier" &&
            row.jsxAttribute === node.name.name &&
            (row.value === undefined ||
              (node.value?.type === "Literal" && node.value.value === row.value))
          ) {
            report(node, row);
          }
        }
      },
    };
  },
};
