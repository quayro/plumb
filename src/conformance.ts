import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { responseSchema } from "./adapter-external.ts";
import { type Adapter, environment, loadAdapterRegistry } from "./adapter-registry.ts";
import type { Diagnostic, Report, Rule } from "./diagnostics.ts";
import { report } from "./engine-plan.ts";
import { errorMessage } from "./errors.ts";
import { digest, globMatches } from "./files.ts";
import { type Execute, run, type RunResult } from "./process.ts";
import { sandboxed } from "./sandbox.ts";
import { validateSchema } from "./schema.ts";

const RULE: Rule = {
  id: "adapters.conformance",
  description: "An external adapter honours the protocol, including its refusals.",
  remedy: "Correct the adapter until every conformance probe passes, then pin the new version.",
  suppressible: false,
};

export const RULES: Rule[] = [RULE];

const EXIT = { pass: 0, violation: 1, incomplete: 2 };

const SOURCE = "\n";

// a path one of the adapter's own patterns selects, or nothing when none can be derived
const sampleFor = (entry: Adapter): string | undefined =>
  entry.files
    .map((glob) => glob.replaceAll("**/", "").replaceAll("*", "sample"))
    .find((path) => !/[?{}[\]!]/.test(path) && globMatches(entry.files, path));

// runs every registered adapter against a scratch project and probes the promises the core relies
// on: a valid, self-consistent answer, and a refusal whenever the request cannot be trusted.
export async function conformance(
  adapters: string | undefined,
  execute: Execute = run,
): Promise<Report> {
  if (!adapters) {
    throw new Error("conformance requires --adapters FILE");
  }
  const scratch = mkdtempSync(join(tmpdir(), "plumb-conformance-")),
    diagnostics: Diagnostic[] = [],
    results: unknown[] = [];
  try {
    for (const entry of loadAdapterRegistry(adapters, scratch)?.adapters ?? []) {
      const root = mkdtempSync(join(scratch, `${entry.id}-`)),
        sample = sampleFor(entry),
        probes: { name: string; passed: boolean }[] = [];
      results.push({ id: entry.id, version: entry.version, probes });
      const record = (name: string, problem?: string, status?: "incomplete"): void => {
        probes.push({ name, passed: !problem });
        if (problem) {
          diagnostics.push({
            rule: RULE.id,
            path: ".",
            message: `${entry.id}: ${name}: ${problem}`,
            remedy: RULE.remedy,
            ...(status ? { status } : {}),
            suppressible: false,
          });
        }
      };
      if (!sample) {
        record(
          "sample",
          `no sample file can be derived from ${entry.files.join(", ")}`,
          "incomplete",
        );
        continue;
      }
      mkdirSync(dirname(join(root, sample)), { recursive: true });
      writeFileSync(join(root, sample), SOURCE);
      const sha256 = digest(SOURCE);
      const request = (extra: Record<string, unknown> = {}): string =>
        `${JSON.stringify({
          schemaVersion: 1,
          action: "check",
          adapter: entry.id,
          version: entry.version,
          root,
          project: { root: ".", profile: entry.id },
          files: [{ path: sample, sha256 }],
          inputs: [{ path: sample, sha256 }],
          capabilities: entry.capabilities,
          ...extra,
        })}\n`;
      // a protocol response whose identity and exit code agree with what it says
      const answer = (result: RunResult) => {
        if (result.error) {
          throw new Error(result.error);
        }
        const response: unknown = JSON.parse(result.stdout);
        validateSchema(response, responseSchema, "adapter response");
        if (
          response.adapter !== entry.id ||
          response.version !== entry.version ||
          result.code !== EXIT[response.status]
        ) {
          throw new Error("the response identity or exit code contradicts its status");
        }
        return response;
      };
      const probe = async (
        name: string,
        input: string,
        problem: (result: RunResult) => string | false,
      ): Promise<void> => {
        try {
          const result = await execute(entry.sandbox ? sandboxed(entry.command) : entry.command, {
            cwd: root,
            timeout: 120000,
            inheritEnv: false,
            env: environment(entry).values,
            input,
          });
          record(name, problem(result) || undefined);
        } catch (error) {
          record(name, errorMessage(error));
        }
      };
      await probe(
        "doctor",
        request({ action: "doctor" }),
        (result) =>
          answer(result).coverage.length > 0 && "a doctor response claims source coverage",
      );
      await probe("check", request(), (result) => {
        const response = answer(result),
          rules = new Set(entry.rules.map((rule) => rule.id));
        if (response.diagnostics.some((item) => !rules.has(item.rule))) {
          return "a diagnostic uses an undeclared rule";
        }
        if (response.coverage.some((row) => !entry.capabilities.includes(row.capability))) {
          return "coverage names an undeclared capability";
        }
        return (
          !response.inputs.some((input) => input.path === sample && input.sha256 === sha256) &&
          "the response omits the hash of the source it read"
        );
      });
      await probe(
        "stale-hash",
        request({ files: [{ path: sample, sha256: digest("other") }] }),
        (result) =>
          answer(result).status !== "incomplete" &&
          "a source that differs from its requested hash was accepted",
      );
      await probe(
        "foreign-version",
        request({ version: "0.0.0-conformance" }),
        (result) => result.code === 0 && "a request for another adapter version passed",
      );
      await probe(
        "malformed",
        "not json\n",
        (result) => result.code === 0 && "a malformed request passed",
      );
      record(
        "read-only",
        readdirSync(root, { recursive: true }).length !== sample.split("/").length ||
          readFileSync(join(root, sample), "utf8") !== SOURCE
          ? "the adapter changed the project it was checking"
          : undefined,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return report(diagnostics, { command: "conformance", adapters: results });
}
