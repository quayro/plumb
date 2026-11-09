import { globMatches } from "../../shared/glob.ts";
import { eslintRuleSchema, type RuleOptions } from "../options.ts";
import type { Node, RuleModule, TSESTree } from "../types.ts";
import { rulesReasoned as reasoned, rulesRelativeTo as relativeTo } from "./shared.ts";

type Options = RuleOptions<"plumb/export-prefix">;

type Kind = NonNullable<Options["kinds"]>[number];

const kindOf = (name: string): Kind =>
  /^[A-Z0-9_]+$/.test(name) && /[A-Z]/.test(name)
    ? "constant"
    : /^[A-Z]/.test(name)
      ? "pascal"
      : "camel";

const camel = (text: string): string =>
  text.replace(/[-_]([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

const typeDeclaration = (node: Node | null | undefined): TSESTree.Identifier | undefined =>
  node?.type === "TSInterfaceDeclaration" ||
  node?.type === "TSTypeAliasDeclaration" ||
  node?.type === "TSEnumDeclaration"
    ? node.id
    : undefined;

const valueDeclaration = (node: Node | null | undefined): TSESTree.Identifier | undefined =>
  node?.type === "FunctionDeclaration" || node?.type === "ClassDeclaration"
    ? (node.id ?? undefined)
    : undefined;

const nameOf = (node: TSESTree.Identifier | TSESTree.StringLiteral): string =>
  node.type === "Identifier" ? node.name : node.value;

// map: rows of { match, names, singular }, and the first match wins;
// singular is true (strip a plural s) or "both" (accept either form);
// a name may use $1 and on, $file, $fileHead and $folder
const ownersOf = (file: string, map: Options["map"], aliases: Record<string, string>): string[] => {
  const parts = file.split("/");
  const stem = (parts.at(-1) ?? "").replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\.d$/, "");
  const module = stem === "index" ? (parts.at(-2) ?? stem) : stem;
  for (const row of map) {
    const match = new RegExp(row.match).exec(file);
    if (!match) {
      continue;
    }
    const names = row.names.map((name) =>
      name
        .replace(/\$(\d)/g, (_, index: string) => match[Number(index)] ?? "")
        .replace("$fileHead", module.split("-")[0] ?? "")
        .replace("$file", module)
        .replace("$folder", parts.length > 2 ? (parts.at(-2) ?? "") : ""),
    );
    const forms = (name: string): string[] =>
      row.singular === "both"
        ? [name, name.replace(/s$/, "")]
        : [row.singular ? name.replace(/s$/, "") : name];
    return [
      ...new Set(
        names
          .filter(Boolean)
          .map((name) => (Object.hasOwn(aliases, name) ? (aliases[name] ?? name) : name))
          .flatMap(forms)
          .map(camel),
      ),
    ];
  }
  return [];
};

const exportPrefixRule: RuleModule<[Partial<Options>?]> = {
  meta: {
    type: "suggestion",
    schema: eslintRuleSchema("plumb/export-prefix"),
    messages: {
      prefix: "An export of {{file}} starts with its owner's name: {{owners}}",
      stale: "Remove the stale export-prefix exception {{name}}; {{file}} no longer exports it.",
    },
  },
  create(context) {
    const {
      root = context.cwd,
      map = [],
      aliases = {},
      kinds = ["camel", "pascal", "constant"],
      exceptions = [],
      skip = [],
      types = false, // interfaces, type aliases and enums carry the prefix too
    } = context.options[0] ?? {};
    const file = relativeTo(root, context.filename);
    const names = ownersOf(file, map, aliases);
    if (names.length === 0) {
      return {}; // a module the map leaves free, as a composition root
    }
    const excepted = new Set(
      reasoned(exceptions, "export-prefix")
        .filter((entry) => entry.file === file)
        .flatMap((entry) => entry.names),
    );
    const skipped = (name: string): boolean =>
      skip.some((entry) => globMatches(entry.files, file) && new RegExp(entry.names).test(name));
    const seen = new Set<string>();
    const fits = (name: string): boolean => {
      const bare = name.replace(/^use(?=[A-Z])/, "").replace(/_/g, "");
      return names.some((owner) => {
        const head = bare.slice(0, owner.length);
        const next = bare.charAt(owner.length);
        return (
          head.toLowerCase() === owner.toLowerCase() && !/[a-z]/.test(next === "" ? "A" : next)
        );
      });
    };
    const check = (node: Node, name: string): void => {
      if (!kinds.includes(kindOf(name)) || skipped(name) || fits(name)) {
        return;
      }
      if (excepted.has(name)) {
        seen.add(name);
        return;
      }
      context.report({
        node,
        messageId: "prefix",
        data: { file, owners: names.join(", ") },
      });
    };
    const checkBinding = (node: Node | null): void => {
      if (!node) {
        return;
      }
      if (node.type === "Identifier") {
        check(node, node.name);
      } else if (node.type === "ObjectPattern") {
        node.properties.forEach((entry) =>
          checkBinding(entry.type === "RestElement" ? entry.argument : entry.value),
        );
      } else if (node.type === "ArrayPattern") {
        node.elements.forEach((element) => {
          checkBinding(element);
        });
      } else if (node.type === "AssignmentPattern") {
        checkBinding(node.left);
      } else if (node.type === "RestElement") {
        checkBinding(node.argument);
      }
    };
    return {
      ExportNamedDeclaration(node) {
        const declaration = node.declaration;
        const typeId = typeDeclaration(declaration);
        if (types && typeId) {
          check(typeId, typeId.name);
          return;
        }
        if (node.exportKind === "type") {
          return;
        }
        const valueId = valueDeclaration(declaration);
        if (valueId) {
          check(valueId, valueId.name);
        }
        if (declaration?.type === "VariableDeclaration") {
          for (const entry of declaration.declarations) {
            checkBinding(entry.id);
          }
        }
        for (const specifier of node.specifiers) {
          const exported = nameOf(specifier.exported);
          const local = nameOf(specifier.local);
          if (specifier.exportKind !== "type" && (!node.source || exported !== local)) {
            check(specifier.exported, exported); // a re-export keeps its owner's name unless renamed
          }
        }
      },
      ExportDefaultDeclaration(node) {
        // export default function Name / class Name carry the owner's prefix like a named export
        const declaration = node.declaration;
        const valueId = valueDeclaration(declaration);
        if (valueId) {
          check(valueId, valueId.name);
        }
        const typeId =
          declaration.type === "TSTypeAliasDeclaration" ? undefined : typeDeclaration(declaration);
        if (types && typeId) {
          check(typeId, typeId.name);
        }
      },
      "Program:exit"(node) {
        for (const name of excepted) {
          if (!seen.has(name)) {
            context.report({ node, messageId: "stale", data: { name, file } });
          }
        }
      },
    };
  },
}; // a name says where it lives, so a call site needs no trip to the import

export const plumbNameRules = {
  "export-prefix": exportPrefixRule,
};
