import type { Config } from "./config.ts";
import { type GeneratedFile, word } from "./hooks.ts";

// actions are pinned to full commits; the version comment is what a reviewer reads
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0";
const BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0";

const ZERO = "0000000000000000000000000000000000000000";

// the required pull-request job, generated from the same argv people and hooks run: the full
// check with the policy ratchet against the base, then every commit and the pull request title.
export function workflowFiles(
  config: Pick<Config, "ci" | "commits">,
  header: string,
): GeneratedFile[] {
  const github = config.ci?.github;
  if (!github) {
    return [];
  }
  const branch = github.branch ?? "main",
    command = github.command.map(word).join(" ");
  const runtime =
    github.command[0] === "bun"
      ? [`      - uses: ${BUN}`, "        with:", "          bun-version-file: package.json"]
      : [`      - uses: ${NODE}`, "        with:", "          node-version: 22.18.0"];
  const pushed = `github.event_name == 'push' && github.ref == 'refs/heads/${branch}' && github.event.before != '${ZERO}'`;
  const lines = [
    header,
    "name: Plumb",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    `    branches: [${JSON.stringify(branch)}]`,
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: plumb-${{ github.ref }}",
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  plumb:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    steps:",
    `      - uses: ${CHECKOUT}`,
    "        with:",
    "          persist-credentials: false",
    "          # the ratchet and the commit checks compare against the base, so they need history",
    "          fetch-depth: 0",
    "          ref: ${{ github.event.pull_request.head.sha || github.sha }}",
    ...runtime,
    ...(github.setup ?? []).map((line) => `      - run: ${JSON.stringify(line)}`),
    "      - name: Check the repository and refuse policy that weakens the base",
    "        env:",
    "          EVENT: ${{ github.event_name }}",
    "          BASE_REF: ${{ github.base_ref }}",
    "          BEFORE: ${{ github.event.before }}",
    "        run: |",
    "          base=",
    '          if [ "$EVENT" = pull_request ]; then',
    '            base="origin/$BASE_REF"',
    `          elif [ "$EVENT" = push ] && [ "$GITHUB_REF" = "refs/heads/${branch}" ] && [ "$BEFORE" != ${ZERO} ]; then`,
    '            base="$BEFORE"',
    "          fi",
    `          ${command} check \${base:+--base "$base"}`,
  ];
  if (config.commits) {
    lines.push(
      "      - name: Check every commit in the pull request",
      "        if: github.event_name == 'pull_request'",
      "        env:",
      "          BASE_REF: ${{ github.base_ref }}",
      `        run: ${JSON.stringify(`${command} commits --range "origin/$BASE_REF..HEAD"`)}`,
      "      - name: Check the pull request title, which becomes the squash subject",
      "        if: github.event_name == 'pull_request'",
      "        env:",
      "          PR_TITLE: ${{ github.event.pull_request.title }}",
      `        run: ${JSON.stringify(`${command} commits --message "$PR_TITLE"`)}`,
      `      - name: Check every commit pushed to ${branch}`,
      `        if: ${pushed}`,
      "        env:",
      "          BEFORE: ${{ github.event.before }}",
      "          AFTER: ${{ github.sha }}",
      `        run: ${JSON.stringify(`${command} commits --range "$BEFORE..$AFTER"`)}`,
    );
  }
  return [{ path: ".github/workflows/plumb.yml", content: `${lines.join("\n")}\n` }];
}
