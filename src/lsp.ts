import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isDiagnostic } from "./diagnostics.ts";
import { at, isArray } from "./schema.ts";

type Run = (argv: readonly string[]) => Promise<{ code: number; text: string }>;

const frame = (message: unknown): string => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...Object(message) });
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

// splits a byte stream into the JSON bodies its Content-Length headers announce
async function* messages(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<unknown> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n"),
        length = /content-length: *(\d+)/i.exec(buffer.subarray(0, Math.max(end, 0)).toString());
      if (end < 0 || !length) {
        // a header block without a length cannot be framed, so it is dropped
        buffer = end < 0 ? buffer : buffer.subarray(end + 4);
        if (end < 0) {
          break;
        }
        continue;
      }
      const start = end + 4,
        stop = start + Number(length[1]);
      if (buffer.length < stop) {
        break;
      }
      try {
        yield JSON.parse(buffer.subarray(start, stop).toString());
      } catch {
        yield undefined;
      }
      buffer = buffer.subarray(stop);
    }
  }
}

// the Language Server Protocol over stdio: every open or save reruns the whole check and
// publishes its diagnostics, so an editor shows exactly what plumb check reports.
// shortcut: each run checks the whole repository; add --cache or per-file runs when a large
// repository makes saves slow.
export async function serveEditor(
  input: AsyncIterable<Uint8Array | string>,
  write: (text: string) => unknown,
  run: Run,
  root: string,
  version: string,
): Promise<number> {
  let published = new Set<string>();
  const publish = async (): Promise<void> => {
    const { text } = await run(["check", "--format", "json"]);
    let found: unknown;
    try {
      found = at(JSON.parse(text), "diagnostics");
    } catch {
      found = [];
    }
    const files = new Map<string, unknown[]>();
    for (const item of (isArray(found) ? found : []).filter(isDiagnostic)) {
      // a repository-wide finding is shown on the policy that asked for it
      const path = !item.path || item.path === "." ? "plumb.json" : item.path,
        line = Math.max((item.line ?? 1) - 1, 0),
        character = Math.max((item.column ?? 1) - 1, 0);
      files.set(path, [
        ...(files.get(path) ?? []),
        {
          range: { start: { line, character }, end: { line, character: character + 1 } },
          // an incomplete check is a failure too, so both statuses are errors
          severity: 1,
          code: item.rule,
          source: "plumb",
          message: `${item.message}${item.remedy ? `\n${item.remedy}` : ""}`,
        },
      ]);
    }
    // a file that was reported before and is clean now gets an empty list, which clears it
    for (const path of new Set([...published, ...files.keys()])) {
      write(
        frame({
          method: "textDocument/publishDiagnostics",
          params: { uri: pathToFileURL(join(root, path)).href, diagnostics: files.get(path) ?? [] },
        }),
      );
    }
    published = new Set(files.keys());
  };
  for await (const message of messages(input)) {
    const id: unknown = at(message, "id"),
      method: unknown = at(message, "method");
    if (method === "exit") {
      return 0;
    }
    if (method === "initialize") {
      write(
        frame({
          id,
          result: {
            capabilities: { textDocumentSync: { openClose: true, change: 0, save: true } },
            serverInfo: { name: "plumb", version },
          },
        }),
      );
    } else if (method === "shutdown") {
      write(frame({ id, result: null }));
    } else if (
      method === "initialized" ||
      method === "textDocument/didOpen" ||
      method === "textDocument/didSave"
    ) {
      await publish();
    } else if (id !== undefined) {
      write(
        frame({
          id: id ?? null,
          error: method
            ? { code: -32601, message: "Method not found" }
            : { code: -32700, message: "Parse error" },
        }),
      );
    }
  }
  return 0;
}
