import { at } from "./schema.ts";

type Run = (argv: readonly string[]) => Promise<{ code: number; text: string }>;

type Reply = { result: unknown } | { error: { code: number; message: string } };

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const input = (...required: string[]): Record<string, unknown> & { required: string[] } => ({
  type: "object",
  properties: Object.fromEntries(required.map((name) => [name, { type: "string" }])),
  required,
  additionalProperties: false,
});

// every tool is one read-only command; each required argument is appended as one argv value
const TOOLS = [
  {
    name: "instructions",
    description: "Before starting work, read the repository's conventions as instructions.",
    argv: ["instructions"],
    inputSchema: input(),
  },
  {
    name: "check",
    description: "Run the complete, read-only policy and return its JSON report.",
    argv: ["check", "--format", "json"],
    inputSchema: input(),
  },
  {
    name: "plan",
    description: "List the checks the policy requires and the files each one covers.",
    argv: ["plan"],
    inputSchema: input(),
  },
  {
    name: "inspect_file",
    description:
      "Before editing a file, show its owners, checks and the conventions that apply to it.",
    argv: ["inspect", "--file"],
    inputSchema: input("path"),
    pick: "file",
  },
  {
    name: "explain",
    description: "Show one rule's purpose and remedy by its exact id from a diagnostic.",
    argv: ["explain"],
    inputSchema: input("rule"),
  },
];

const invalid = (message: string): Reply => ({ error: { code: -32602, message } });

async function call(params: unknown, run: Run): Promise<Reply> {
  const tool = TOOLS.find((entry) => entry.name === at(params, "name"));
  if (!tool) {
    return invalid("Unknown tool; list them with tools/list");
  }
  const values: string[] = [];
  for (const name of tool.inputSchema.required) {
    const value = at(params, "arguments", name);
    // a value that starts an option would change the command the server was started to run
    if (typeof value !== "string" || !value || value.startsWith("-")) {
      return invalid(`${tool.name} needs ${name} as text that is not an option`);
    }
    values.push(value);
  }
  const { code, text } = await run([...tool.argv, ...values]);
  const picked: unknown = tool.pick && code === 0 ? at(JSON.parse(text), tool.pick) : undefined;
  return {
    result: {
      content: [{ type: "text", text: picked ? JSON.stringify(picked, null, 2) : text }],
      // a violation and an incomplete check both fail the call: neither may read as a pass
      isError: code !== 0,
    },
  };
}

async function answer(message: unknown, run: Run, version: string): Promise<Reply> {
  const params = at(message, "params");
  switch (at(message, "method")) {
    case "initialize": {
      const wanted = at(params, "protocolVersion");
      return {
        result: {
          protocolVersion: VERSIONS.find((entry) => entry === wanted) ?? VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "plumb", version },
        },
      };
    }
    case "ping":
      return { result: {} };
    case "tools/list":
      return {
        result: {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        },
      };
    case "tools/call":
      return await call(params, run);
    default:
      return { error: { code: -32601, message: "Method not found" } };
  }
}

// the Model Context Protocol over stdio: one JSON-RPC message per line, answered in order
export async function serve(
  lines: AsyncIterable<string>,
  write: (text: string) => unknown,
  run: Run,
  version: string,
): Promise<number> {
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let message: unknown, reply: Reply | undefined;
    try {
      message = JSON.parse(line);
    } catch {
      reply = { error: { code: -32700, message: "Parse error" } };
    }
    // a message without an id is a notification and gets no reply
    if (!reply && at(message, "id") === undefined) {
      continue;
    }
    reply ??= await answer(message, run, version);
    write(`${JSON.stringify({ jsonrpc: "2.0", id: at(message, "id") ?? null, ...reply })}\n`);
  }
  return 0;
}
