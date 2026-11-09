import type { EngineOptions } from "./engine.ts";

export const USAGE = `Plumb — executable repository contracts

Usage: plumb <command> [options]

  init                  create plumb.json from the detected languages; never overwrite files
  packs                 list the policy packs of a registry with their pinned hashes
  vendor                install or update the checker in tools/plumb, pinned to a revision
  check                 run the complete, read-only policy
  plan                  show required checks, ownership and task obligations
  doctor                check prerequisites and suggest adoption steps
  inspect               show effective policy, coverage and rule metadata
  explain RULE          show one rule's purpose and remedy
  fix                   apply conservative source formatting, then check
  sync                  write or repair Plumb-owned files and executable modes
  snapshot              explicitly update configured public API snapshots
  prepare               explicitly run configured code-generation commands
  policy-diff           compare effective policy with --against FILE
  pin-policy FILE       print an offline bundle reference with its content hash
  pin-input PATH        print the digest for an approved input file or directory
  policy-test           run approved convention examples and intentional violations
  commit-msg FILE       check one commit message file, as the generated commit-msg hook does
  commits --range A..B  check every commit in a range; --message TEXT checks one subject line
  scaffold ROLE NAME    validate and create policy-defined source and companion files
  baseline              print exceptions that budget today's violations, for review
  progress              summarize violations and exception budgets; --base adds their change
  upgrade               preview adopting --policy FILE: policy changes and new violations
  conformance           probe every adapter in --adapters FILE against the protocol
  instructions          print the effective policy as instructions for a coding agent
  mcp                   serve the read-only commands to an agent over stdio
  lsp                   serve check diagnostics to an editor over the Language Server Protocol
  version               print the checker identity and verify a vendored install (--version)

  --root PATH           project root (otherwise discover plumb.json upwards)
  --config FILE         repository-relative JSON policy (default plumb.json)
  --policy FILE         use an approved policy outside the candidate checkout
  --task FILE           add an approved external task contract
  --adapters FILE       use an approved external pinned adapter registry
  --inputs FILE         add explicitly pinned inputs to an isolated check
  --file PATH           explain one file's owner, checks and exclusions (inspect)
  --dry-run             preview conservative repairs or scaffolding
  --apply FILE          apply a reviewed repair plan after hash/mode validation
  --output FILE         save JSON, SARIF or a repair plan outside the project
  --cache DIRECTORY     reuse unchanged deterministic core results outside CI
  --format FORMAT       text, json, or sarif (check only)
  --profile PROFILE     init a typescript, react, ruby, cpp or generic project (default: detect)
  --preset PRESET       init with ozmikhail (default) or portable
  --pack NAMES          init with these comma-separated packs, copied and pinned as bundles
  --type TYPE           init with the packs for an application, library or documentation
  --interactive         init by answering questions; defaults come from the repository
  --index FILE          packs, init: use this registry index instead of the shipped packs
  --export DIRECTORY    packs: write the registry as a directory others can host
  --from SOURCE         vendor: the upstream repository or a local clone (default: this clone)
  --revision REV        vendor: the tag, branch or commit to pin (default: HEAD)
  --project PATH        snapshot only this configured project
  --base REF            check: report policy changes that weaken the git revision REF
  --observe             check: report violations without failing; incomplete still fails

Exit codes: 0 complete success; 1 policy violation; 2 incomplete or invalid invocation.
`;

const VALUE_FLAGS = [
  "root",
  "config",
  "policy",
  "format",
  "profile",
  "preset",
  "project",
  "task",
  "adapters",
  "inputs",
  "file",
  "apply",
  "output",
  "against",
  "cache",
  "range",
  "message",
  "base",
  "pack",
  "type",
  "index",
  "export",
  "from",
  "revision",
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

const isValueFlag = (name: string): name is ValueFlag => VALUE_FLAGS.some((flag) => flag === name);

const BOOLEAN_FLAGS = ["dry-run", "observe", "interactive"] as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];

const isBooleanFlag = (name: string): name is BooleanFlag =>
  BOOLEAN_FLAGS.some((flag) => flag === name);

type Flags = Partial<Record<ValueFlag, string>> & Partial<Record<BooleanFlag, boolean>>;

export type CliOptions = Omit<Flags, "dry-run"> &
  EngineOptions & {
    command: string;
    rest: string[];
    root: string;
    dryRun?: boolean;
  };

export function argumentsOf(args: readonly string[]): Omit<CliOptions, "root"> & { root?: string } {
  const options: Flags = {},
    positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const name = arg.startsWith("--") ? arg.slice(2) : "";
    if (isValueFlag(name)) {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      if (Object.hasOwn(options, name)) {
        throw new Error(`${arg} was supplied twice`);
      }
      options[name] = value;
      i++;
    } else if (isBooleanFlag(name)) {
      if (Object.hasOwn(options, name)) {
        throw new Error(`${arg} was supplied twice`);
      }
      options[name] = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [command = "", ...rest] = positional;
  if (options.format && !["text", "json", "sarif"].includes(options.format)) {
    throw new Error("--format is text, json, or sarif");
  }
  if (options.format === "sarif" && command !== "check") {
    throw new Error("SARIF output is only supported by check");
  }
  if (
    (options.profile || options.preset || options.pack || options.type || options.interactive) &&
    command !== "init"
  ) {
    throw new Error("--profile, --preset, --pack, --type and --interactive belong to init");
  }
  if (options.index && !["packs", "init"].includes(command)) {
    throw new Error("--index is supported by packs and init");
  }
  if (options.export && command !== "packs") {
    throw new Error("--export is only supported by packs");
  }
  if ((options.from || options.revision) && command !== "vendor") {
    throw new Error("--from and --revision are only supported by vendor");
  }
  if (options.project && command !== "snapshot") {
    throw new Error("--project is only supported by snapshot");
  }
  if (options.cache && command !== "check") {
    throw new Error("Result caching is only supported by check");
  }
  if (options.base && !["check", "progress"].includes(command)) {
    throw new Error("--base is supported by check and progress");
  }
  if (options.observe && command !== "check") {
    throw new Error("--observe is only supported by check");
  }
  if (command === "upgrade" && !options.policy) {
    throw new Error("upgrade requires --policy FILE, the policy to adopt");
  }
  if (options.base && options.cache) {
    throw new Error("--base cannot be combined with --cache");
  }
  if (options.task && !["check", "plan", "doctor"].includes(command)) {
    throw new Error("--task is supported by check, plan and doctor");
  }
  if (options.inputs && !["check", "fix", "policy-test", "scaffold"].includes(command)) {
    throw new Error("--inputs is supported by check, fix, policy-test and scaffold");
  }
  if (options.file && command !== "inspect") {
    throw new Error("--file is only supported by inspect");
  }
  if (options["dry-run"] && !["fix", "scaffold"].includes(command)) {
    throw new Error("--dry-run is supported by fix and scaffold");
  }
  if (options.apply && command !== "fix") {
    throw new Error("--apply is only supported by fix");
  }
  if (options["dry-run"] && options.apply) {
    throw new Error("Choose repair preview or plan application");
  }
  if (
    (options.against && command !== "policy-diff") ||
    (command === "policy-diff" && !options.against)
  ) {
    throw new Error("policy-diff requires --against FILE");
  }
  if (
    options.output &&
    ![
      "check",
      "plan",
      "doctor",
      "inspect",
      "fix",
      "policy-test",
      "scaffold",
      "policy-diff",
      "pin-policy",
      "pin-input",
      "progress",
      "upgrade",
    ].includes(command)
  ) {
    throw new Error("This command does not produce a saved report");
  }
  if (options.range !== undefined || options.message !== undefined) {
    if (command !== "commits") {
      throw new Error("--range and --message are only supported by commits");
    }
    if ((options.range === undefined) === (options.message === undefined)) {
      throw new Error("commits needs exactly one of --range or --message");
    }
  }
  if (
    rest.length !==
    (command === "scaffold"
      ? 2
      : ["explain", "pin-policy", "pin-input", "commit-msg"].includes(command)
        ? 1
        : 0)
  ) {
    throw new Error(`${command} has invalid positional arguments`);
  }
  return {
    command,
    rest,
    ...options,
    configFile: options.config,
    inputManifest: options.inputs,
    dryRun: options["dry-run"],
  };
}
