import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import prettier from "prettier";

import { protocolSchema } from "../src/adapter-external.ts";
import { schema } from "../src/config.ts";
import { at } from "../src/schema.ts";

const prettierConfig: unknown = JSON.parse(
  readFileSync(new URL("../packages/javascript/assets/prettier.json", import.meta.url), "utf8"),
);
const printWidth = Number(at(prettierConfig, "printWidth"));

// the published schema is written in the pack's formatting so plumb check accepts it unchanged
export const publishedSchema = (): Promise<string> =>
  prettier.format(JSON.stringify(schema), { printWidth, parser: "json" });

// the adapter protocol is published the same way, so a change to the plugin API is a reviewed diff
export const publishedProtocol = (): Promise<string> =>
  prettier.format(JSON.stringify(protocolSchema), { printWidth, parser: "json" });

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeFileSync(new URL("../plumb.schema.json", import.meta.url), await publishedSchema());
  writeFileSync(
    new URL("../adapter-protocol.schema.json", import.meta.url),
    await publishedProtocol(),
  );
}
