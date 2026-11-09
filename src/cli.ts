import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { diffPolicies } from "./bundles.ts";
import { argumentsOf, type CliOptions, USAGE } from "./cli-arguments.ts";
import { commitCheck, discover, init, issue, mutation, saveOutput } from "./cli-commands.ts";
import { loadConfig, schema, validateSchema } from "./config.ts";
import { isDiagnostic, isStatus, toSarif } from "./diagnostics.ts";
import {
  checkRepository,
  context,
  coreRules,
  doctor,
  inspect,
  planRepository,
  report,
  scaffoldRepository,
  testPolicy,
} from "./engine.ts";
import { errorMessage } from "./errors.ts";
import { digest, globMatches, normalize, protectedPolicyFiles } from "./files.ts";
import { inputDigest } from "./inputs.ts";
import { at, isArray } from "./schema.ts";

type Output = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === "string";

const textOf = (value: unknown): string | undefined => (isText(value) ? value : undefined);

// a command result is a report when it carries a status and its diagnostics; SARIF describes only
// reports
const sarifOf = (result: Output): unknown =>
  isStatus(result.status) && isArray(result.diagnostics)
    ? toSarif({
        ...result,
        status: result.status,
        diagnostics: result.diagnostics.filter(isDiagnostic),
        suppressed: isArray(result.suppressed) ? result.suppressed.filter(isDiagnostic) : [],
      })
    : result;

export async function main(
  args: readonly string[],
  output: (text: string) => unknown = (text) => process.stdout.write(text),
): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args[0] === "help") {
    output(USAGE);
    return 0;
  }
  let options: CliOptions | undefined, result: Output;
  try {
    const parsed = argumentsOf(args);
    if (parsed.configFile && normalize(parsed.configFile) !== "plumb.json") {
      // a policy outside plumb.json can be swapped by the change under review, so CI and base
      // comparisons refuse it.
      if ((process.env.CI && !/^(?:false|0)$/i.test(process.env.CI)) || parsed.base) {
        throw new Error(
          `--config ${parsed.configFile} is refused in CI and with --base; the policy must be plumb.json`,
        );
      }
      if (!globMatches(protectedPolicyFiles, parsed.configFile)) {
        throw new Error(`--config ${parsed.configFile} must match a protected policy pattern`);
      }
    }
    options = {
      ...parsed,
      root: parsed.root
        ? resolve(parsed.root)
        : await discover(process.cwd(), parsed.configFile ?? "plumb.json"),
    };
    switch (options.command) {
      case "init":
        result = init(options);
        break;
      case "check":
        result = await checkRepository(options);
        break;
      case "policy-test":
        result = await testPolicy(options);
        break;
      case "scaffold":
        result = await scaffoldRepository({
          ...options,
          role: options.rest[0],
          name: options.rest[1],
        });
        break;
      case "plan":
        result = planRepository(options);
        break;
      case "doctor":
        result = await doctor(options);
        break;
      case "inspect":
        result = await inspect(options);
        break;
      case "policy-diff": {
        const current = context(options),
          previous = loadConfig(current.root, options.configFile, resolve(options.against ?? ""));
        result = {
          schemaVersion: 1,
          command: "policy-diff",
          changes: diffPolicies(
            { value: previous.config, origins: previous.origins },
            { value: current.config, origins: current.origins },
          ),
        };
        break;
      }
      case "pin-policy": {
        const path = resolve(options.rest[0] ?? ""),
          bytes = readFileSync(path);
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        validateSchema(value, schema);
        result = { path, sha256: digest(bytes) };
        break;
      }
      case "pin-input": {
        const source = resolve(options.rest[0] ?? "");
        result = { source, sha256: inputDigest(source) };
        break;
      }
      case "explain": {
        const id = options.rest[0] ?? "";
        let rules: unknown[] = coreRules();
        if (!rules.some((rule) => at(rule, "id") === id)) {
          const inspected = (await inspect(options)).rules;
          rules = isArray(inspected) ? inspected : [];
        }
        const rule = rules.find((entry) => at(entry, "id") === id);
        if (!rule) {
          throw new Error(`Unknown rule ${id}; run plumb inspect`);
        }
        result = { schemaVersion: 1, rule };
        break;
      }
      case "fix":
      case "sync":
      case "snapshot":
      case "prepare":
        result = await mutation(options);
        break;
      case "commit-msg":
      case "commits":
        result = await commitCheck(options);
        break;
      default:
        throw new Error(`Unknown command ${options.command}; run plumb --help`);
    }
    if (options.output) {
      result.saved = saveOutput(
        options.root,
        options.output,
        options.dryRun && result.plan
          ? result.plan
          : options.format === "sarif"
            ? sarifOf(result)
            : result,
      );
    }
  } catch (error) {
    result = report([
      issue(
        "run.failed",
        ".",
        errorMessage(error),
        "Correct the invocation or configuration and retry.",
      ),
    ]);
  }
  if (options?.format === "sarif" || (args.includes("sarif") && args.includes("--format"))) {
    output(`${JSON.stringify(sarifOf(result), null, 2)}\n`);
  } else if (
    options?.format === "json" ||
    (args.includes("json") && args.includes("--format")) ||
    ["inspect", "explain", "plan", "doctor", "policy-diff", "pin-policy", "pin-input"].includes(
      options?.command ?? "",
    )
  ) {
    output(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    // every text-mode command returns a report, with these optional extras
    const shown = {
      diagnostics: isArray(result.diagnostics) ? result.diagnostics.filter(isDiagnostic) : [],
      written: isArray(result.written) ? result.written.filter(isText) : [],
      patch: textOf(at(result, "plan", "patch")),
      saved: textOf(result.saved),
      status: textOf(result.status),
      suppressed: isArray(result.suppressed) ? result.suppressed : [],
      next: textOf(result.next),
    };
    for (const diagnostic of shown.diagnostics) {
      output(
        `${diagnostic.path ?? "."}${diagnostic.line ? `:${diagnostic.line}` : ""} [${diagnostic.rule}] ${diagnostic.message}\n  ${diagnostic.remedy ?? ""}\n`,
      );
    }
    for (const path of shown.written) {
      output(`Wrote ${path}\n`);
    }
    if (shown.patch) {
      output(shown.patch);
    }
    if (shown.saved) {
      output(`Saved ${shown.saved}\n`);
    }
    output(
      `Plumb: ${shown.status ?? "complete"}${shown.suppressed.length ? ` (${shown.suppressed.length} declared exceptions)` : ""}\n`,
    );
    if (shown.next) {
      output(`${shown.next}\n`);
    }
  }
  const code = result.exitCode;
  return typeof code === "number" ? code : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
