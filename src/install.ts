import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Diagnostic, Rule } from "./diagnostics.ts";
import { run } from "./process.ts";

export const RULES: Rule[] = [
  {
    id: "install.modified",
    description: "A vendored checker is byte for byte the upstream revision it is pinned to.",
    remedy: "Restore the vendored checker from its pinned revision, or pull and pin a new one.",
    suppressible: false,
  },
  {
    id: "install.revision",
    description: "The pinned upstream revision of a vendored checker is available to compare.",
    remedy: "Fetch the upstream repository so the pinned revision exists locally, then retry.",
    suppressible: false,
  },
];

// a vendored checker sits beside DIRECTORY.revision, the upstream commit it was read from. The
// committed tree and the working files must both equal that commit, or the checker that judges
// the repository is not the one that was reviewed.
export async function verifyInstall(
  directory: string,
): Promise<{ revision?: string; diagnostics: Diagnostic[] }> {
  const file = `${directory}.revision`;
  if (!existsSync(file)) {
    return { diagnostics: [] };
  }
  const revision = readFileSync(file, "utf8").trim(),
    git = (...args: string[]) => run(["git", "-C", directory, ...args], { timeout: 60000 });
  const problem = (
    index: number,
    message: string,
  ): { revision: string; diagnostics: Diagnostic[] } => {
    const rule = RULES[index];
    return {
      revision,
      diagnostics: [
        {
          rule: rule?.id ?? "install.revision",
          path: ".",
          message,
          remedy: rule?.remedy,
          status: index ? "incomplete" : "violation",
          suppressible: false,
        },
      ],
    };
  };
  if (!/^[0-9a-f]{40,64}$/.test(revision)) {
    return problem(1, `${file} does not hold a full commit hash.`);
  }
  const [pinned, vendored, dirty] = await Promise.all([
    git("rev-parse", "--verify", "--quiet", `${revision}^{tree}`),
    git("rev-parse", "--verify", "--quiet", "HEAD:./"),
    git("status", "--porcelain", "--", "."),
  ]);
  if (pinned.code !== 0 || vendored.code !== 0 || dirty.code !== 0) {
    return problem(1, `Revision ${revision} or the vendored tree cannot be read from git.`);
  }
  if (pinned.stdout.trim() !== vendored.stdout.trim() || dirty.stdout.trim()) {
    return problem(0, `The vendored checker differs from its pinned revision ${revision}.`);
  }
  return { revision, diagnostics: [] };
}

const TARGET = "tools/plumb";

// installs or updates the vendored checker: the exact tree of one upstream commit under
// tools/plumb, staged with its revision so the change is one ordinary commit. Local edits to the
// vendored copy are never discarded silently.
export async function vendor(
  root: string,
  source: string,
  revision = "HEAD",
): Promise<{ revision: string; written: string[] }> {
  const git = async (...args: string[]): Promise<string> => {
    const result = await run(["git", "-C", root, "-c", "protocol.ext.allow=never", ...args], {
      timeout: 300000,
    });
    if (result.error || result.code !== 0) {
      throw new Error(`git ${args[0] ?? ""} failed: ${(result.error ?? result.stderr).trim()}`);
    }
    return result.stdout.trim();
  };
  if (source.startsWith("-") || !/^[^-\s][^\s]*$/.test(revision)) {
    throw new Error("vendor takes a repository and a revision, not options");
  }
  if (realpathSync(await git("rev-parse", "--show-toplevel")) !== realpathSync(root)) {
    throw new Error("vendor runs at the root of the repository that vendors the checker");
  }
  if (await git("status", "--porcelain", "--", TARGET, `${TARGET}.revision`)) {
    throw new Error(
      `${TARGET} has uncommitted changes; commit or restore them before replacing it`,
    );
  }
  await git("fetch", "-q", "--no-tags", source, revision);
  const commit = await git("rev-parse", "--verify", "FETCH_HEAD^{commit}");
  if (await git("ls-files", "--", TARGET)) {
    await git("rm", "-rq", "--cached", "--", TARGET);
  }
  rmSync(join(root, TARGET), { recursive: true, force: true });
  await git("read-tree", `--prefix=${TARGET}/`, "-u", commit);
  writeFileSync(join(root, `${TARGET}.revision`), `${commit}\n`);
  await git("add", "--", `${TARGET}.revision`);
  return { revision: commit, written: [TARGET, `${TARGET}.revision`] };
}
