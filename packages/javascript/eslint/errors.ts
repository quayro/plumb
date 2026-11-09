import { globMatches } from "../shared/glob.ts";
import { effectOrigins, unwrapExpression } from "./effects.ts";
import type { ErrorHandlingOptions } from "./options.ts";
import { rulesRelativeTo } from "./rules/shared.ts";
import {
  type ImportReference,
  type Node,
  plumbSettings,
  type RuleModule,
  type TypedServices,
} from "./types.ts";

const empty = (body: Node | null | undefined): boolean =>
  body?.type === "BlockStatement" && body.body.every((item) => item.type === "EmptyStatement");

const bodyOf = (node: Node | undefined): Node | undefined =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression"
    ? node.body
    : undefined;

export const errorHandlingRule: RuleModule<[(ErrorHandlingOptions & { root?: string })?]> = {
  meta: {
    type: "problem",
    schema: [{ type: "object" }],
    messages: {
      empty: "Handle, translate or rethrow the failure; an empty catch cannot silently discard it.",
      thrown: "Throw an Error value, never a primitive, object literal or array.",
      factory:
        "Create thrown errors through an approved imported factory, or rethrow a caught Error after narrowing it.",
      resultThrow:
        "This scope returns its approved Result type; explicit throws violate that error convention.",
      result:
        "Exported callable {{name}} must return the approved Result type, directly or through Promise.",
      background:
        "Await or return asynchronous work, or pass one async callback to an approved imported background wrapper returning void.",
      unresolved: "Cannot verify the configured error or async convention: {{detail}}",
    },
  },
  create(context) {
    const { root = context.cwd, ...configured } = context.options[0] ?? {};
    const selected =
      !configured.files || globMatches(configured.files, rulesRelativeTo(root, context.filename));
    const policy: ErrorHandlingOptions = selected ? configured : {},
      typed = plumbSettings(context).plumbTyped,
      effects = effectOrigins(context);
    const requiresTypes = !!(policy.factories || policy.result || policy.background);
    // the typed services, once the Program is known to come from a trusted typed parse
    let ready: TypedServices | undefined;
    const report = (node: Node, messageId: string, detail?: string): void =>
      context.report({
        node,
        messageId,
        ...(detail ? { data: { detail } } : {}),
      });
    const approved = (
      services: TypedServices,
      node: Node,
      references: readonly ImportReference[],
    ): boolean | undefined => {
      const values = references.map((reference) => services.matches(context, node, reference));
      return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
    };
    return {
      Program(node) {
        ready = context.sourceCode.parserServices?.program ? typed : undefined;
        if (requiresTypes && !ready) {
          report(node, "unresolved", "a trusted typed Program is required for this scope");
        }
      },
      CatchClause(node) {
        if (empty(node.body)) {
          report(node, "empty");
        }
      },
      ThrowStatement(node) {
        const value = unwrapExpression(node.argument);
        if (
          value &&
          ["Literal", "TemplateLiteral", "ObjectExpression", "ArrayExpression"].includes(value.type)
        ) {
          report(node, "thrown");
        }
        if (policy.result) {
          report(node, "resultThrow");
          return;
        }
        if (!policy.factories || !ready) {
          return;
        }
        if (!value || effects.origins(value).some((origin) => origin.caught && !origin.uncertain)) {
          return;
        }
        const created = effects.initialization(value);
        const match =
          created?.type === "CallExpression"
            ? approved(ready, created.callee, policy.factories)
            : false;
        if (match !== true) {
          report(
            node,
            match === undefined ? "unresolved" : "factory",
            match === undefined ? "the approved factory symbol could not be resolved" : undefined,
          );
        }
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (
          callee?.type === "MemberExpression" &&
          ((!callee.computed &&
            callee.property.type === "Identifier" &&
            callee.property.name === "catch") ||
            effects.literal(callee.property) === "catch") &&
          typed?.promise(context, callee.object) === true &&
          empty(bodyOf(node.arguments[0]))
        ) {
          report(node, "empty");
        }
        if (!policy.background || !ready) {
          return;
        }
        const match = approved(ready, node.callee, policy.background);
        if (match !== true) {
          return;
        }
        const shape = ready.background(context, node);
        if (!shape) {
          report(
            node,
            "unresolved",
            "the background wrapper's argument and return types are unresolved",
          );
        } else if (!shape.voidReturn || !shape.asyncArgument) {
          report(node, "background");
        }
      },
      ExpressionStatement(node) {
        if (!policy.background || !ready) {
          return;
        }
        const expression = unwrapExpression(node.expression),
          value =
            expression?.type === "UnaryExpression" && expression.operator === "void"
              ? unwrapExpression(expression.argument)
              : expression;
        if (!value || value.type === "AwaitExpression") {
          return;
        }
        const promise = ready.promise(context, value);
        if (promise === true) {
          report(node, "background");
          return;
        }
        if (value.type !== "CallExpression") {
          return;
        }
        const shape = ready.background(context, value),
          match = approved(ready, value.callee, policy.background);
        if (shape?.voidReturn && shape.asyncArgument && match !== true) {
          report(
            node,
            match === undefined ? "unresolved" : "background",
            match === undefined ? "the background wrapper symbol could not be resolved" : undefined,
          );
        }
      },
      "Program:exit"(node) {
        if (!policy.result || !ready) {
          return;
        }
        const exports = ready.resultExports(context, policy.result);
        if (!exports) {
          report(
            node,
            "unresolved",
            "the approved Result type or module exports could not be resolved",
          );
          return;
        }
        for (const exported of exports) {
          if (exported.unresolved) {
            report(node, "unresolved", `the return type of ${exported.name} is unresolved`);
          } else if (!exported.valid) {
            context.report({
              node,
              messageId: "result",
              data: { name: exported.name },
            });
          }
        }
      },
    };
  },
};
