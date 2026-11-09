import { globMatches } from "../shared/glob.ts";
import { rulesRelativeTo } from "./rules/shared.ts";
import type { Node, RuleModule } from "./types.ts";

// every built-in error constructor: Error(...) with or without new, subclasses and global aliases
// are one family
const ERROR_KINDS = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
];

interface Selector {
  selector: string;
  message: string;
}

export interface SyntaxOptions {
  root: string;
  source: string | readonly string[];
  profile?: string;
  logCalls?: string;
  errorFactory?: { allowIn?: string[]; message: string };
  syntax?: { files?: string[]; selectors: Selector[] }[];
}

export const syntaxSelectors = (
  { root, source, profile, logCalls, errorFactory, syntax = [] }: SyntaxOptions,
  filename: string,
): Selector[] => {
  const file = rulesRelativeTo(root, filename);
  const selectors: Selector[] = [
    {
      selector: "CatchClause > Identifier.param[name!='error']",
      message: "Catch as catch (error), or catch { when the error is not read.",
    },
    {
      selector: "CatchClause > Identifier.param[typeAnnotation]",
      message: "Catch as catch (error), or catch { when the error is not read.",
    },
  ];
  if (logCalls) {
    for (const kind of ["TemplateLiteral", "BinaryExpression"]) {
      selectors.push({
        selector: `CallExpression[callee.name=/${logCalls.replaceAll("/", "\\/")}/] > ${kind}.arguments:first-child`,
        message: "A log message is a fixed string; its values ride in the fields.",
      });
    }
  }
  if (errorFactory && !globMatches(errorFactory.allowIn ?? [], file)) {
    const kinds = `^(?:${ERROR_KINDS.join("|")})$`,
      globals = "^(?:globalThis|window|self|global)$";
    for (const selector of [
      `NewExpression[callee.name=/${kinds}/]`,
      `CallExpression[callee.name=/${kinds}/]`,
      `CallExpression[callee.object.name='Reflect'][callee.property.name='construct'] > Identifier.arguments:first-child[name=/${kinds}/]`,
      `MemberExpression[object.name=/${globals}/][property.name=/${kinds}/]`,
      `MemberExpression[object.name=/${globals}/][property.value=/${kinds}/]`,
      `VariableDeclarator > Identifier.init[name=/${kinds}/]`,
      `AssignmentExpression > Identifier.right[name=/${kinds}/]`,
    ]) {
      selectors.push({ selector, message: errorFactory.message });
    }
  }
  if (profile === "react" && globMatches(source, file)) {
    selectors.push({
      selector: "AwaitExpression:not(:function AwaitExpression)",
      message: "Await inside a function: a top-level await holds the entry chunk.",
    });
  }
  for (const row of syntax) {
    if (!row.files || globMatches(row.files, file)) {
      selectors.push(...row.selectors);
    }
  }
  return selectors;
};

// selectors share one rule instance, so overlapping scopes add restrictions rather than replace them
export const syntaxRule: RuleModule<[SyntaxOptions]> = {
  meta: {
    type: "problem",
    schema: [{ type: "object" }],
    messages: { restricted: "{{message}}" },
  },
  create(context) {
    const visitors: Record<string, (node: Node) => void> = {};
    // the pack passes its validated options as this rule's only option
    const [options] = context.options;
    for (const { selector, message } of syntaxSelectors(options, context.filename)) {
      const previous = visitors[selector];
      visitors[selector] = (node) => {
        previous?.(node);
        context.report({ node, messageId: "restricted", data: { message } });
      };
    }
    return visitors;
  },
};
