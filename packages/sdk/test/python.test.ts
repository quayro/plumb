import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { contractAssert, folder } from "./support.ts";

const sdk = fileURLToPath(new URL("..", import.meta.url));

const TOY = `import sys

sys.path.append(${JSON.stringify(sdk)})
from adapter import serve


def check(file, options):
    if "crash" in file["text"]:
        raise RuntimeError("parser gave up")
    if "stray" in file["text"]:
        return [{"rule": "undeclared", "message": "x"}]
    return [{"rule": "word", "message": "bad word", "line": 1, "column": 1}] if "bad" in file["text"] else []


serve({
    "id": "toy",
    "version": "2.0.0",
    "files": ["**/*.toy"],
    "capabilities": ["policy"],
    "rules": [{"id": "word", "description": "No bad words.", "remedy": "Remove the word."}],
    "check": check,
}, __file__)
`;

await test("the Python SDK keeps the adapter contract from request to registry", async (t) => {
  const script = join(folder(t, "plumb-sdk-python-"), "toy.py");
  writeFileSync(script, TOY);
  await contractAssert(t, [process.env.PLUMB_TEST_PYTHON ?? "python3", "-I", "-S", "-B", script]);
});
