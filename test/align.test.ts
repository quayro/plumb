import assert from "node:assert/strict";
import test from "node:test";

import { alignKeyColumns, alignMarkdownTables, displayWidth, sortJsonKeys } from "../src/align.ts";
import { at } from "../src/schema.ts";
import { keysOf, parseJson } from "./support.ts";

const once = (fn: (text: string) => string, source: string): void =>
  assert.equal(fn(fn(source)), fn(source));

await test("display width counts wide and combining characters as a monospace view shows them", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("日本"), 4);
  assert.equal(displayWidth("é"), 1);
  assert.equal(displayWidth("🙂"), 2);
});

await test("table cells pad to their column and keep alignment markers", () => {
  const source = "| a | bb |\n|---|:-:|\n| ccc | d |\n";
  assert.equal(alignMarkdownTables(source), "| a   | bb  |\n| --- | :-: |\n| ccc |  d  |\n");
  assert.equal(
    alignMarkdownTables("| n |\n|--:|\n| 1 |\n| 100 |\n"),
    "|   n |\n| --: |\n|   1 |\n| 100 |\n",
  );
  once(alignMarkdownTables, source);
});

await test("a table wider than the print width is still padded", () => {
  const wide = "x".repeat(60);
  const out = alignMarkdownTables(
    `| a | b | c |\n|---|---|---|\n| ${wide} | ${wide} | 1 |\n| 2 | 3 | 4 |\n`,
  );
  const rows = out.trimEnd().split("\n");
  assert.ok(rows[2].length > 100);
  assert.equal(new Set(rows.map(displayWidth)).size, 1);
  once(alignMarkdownTables, out);
});

await test("escaped pipes stay inside their cell, and code-span pipes split cells as in GFM", () => {
  assert.equal(
    alignMarkdownTables("| a | b |\n|---|---|\n| p \\| q | r |\n"),
    "| a      | b   |\n| ------ | --- |\n| p \\| q | r   |\n",
  );
  assert.equal(
    alignMarkdownTables("| a | b |\n|---|---|\n| `x|y` |\n"),
    "| a   | b   |\n| --- | --- |\n| `x  | y`  |\n",
  );
});

await test("fenced tables and pipe lines without a delimiter row are untouched", () => {
  const fenced = "```\n| a | bb |\n|---|---|\n```\n";
  assert.equal(alignMarkdownTables(fenced), fenced);
  const prose = "a | b\nc | d\n";
  assert.equal(alignMarkdownTables(prose), prose);
});

await test("key columns align value and comment columns within a run", () => {
  assert.equal(
    alignKeyColumns("A string # one\nLONG_NAME nonEmpty # two\n"),
    "A         string   # one\nLONG_NAME nonEmpty # two\n",
  );
  once(alignKeyColumns, "A string # one\nLONG_NAME nonEmpty # two\n");
});

await test("blank lines and full-line comments break a run", () => {
  const source = "A x # 1\n\nLONG y # 2\n# note\nB zz # 3\n";
  assert.equal(alignKeyColumns(source), source);
});

await test("assignment lines pad only the comment column and never change the value", () => {
  assert.equal(alignKeyColumns("A=1 # one\nLONG=22 # two\n"), "A=1     # one\nLONG=22 # two\n");
});

await test("a hash inside quotes or a URL is not a comment, and unparseable lines pass through", () => {
  assert.equal(
    alignKeyColumns('URL "a # b" # real\nX y # z\n'),
    'URL "a # b" # real\nX   y       # z\n',
  );
  assert.equal(alignKeyColumns("URL=http://x/#frag\n"), "URL=http://x/#frag\n");
  assert.equal(
    alignKeyColumns("A b\nLONGER c # d\nX y # z\n"),
    "A b\nLONGER c # d\nX      y # z\n",
  );
  const odd = "  !! not a key line\n";
  assert.equal(alignKeyColumns(odd), odd);
});

await test("JSON keys sort to the requested depth and arrays keep their order", () => {
  const source = '{"b":1,"a":{"d":1,"c":2},"z":[3,1]}\n';
  assert.deepEqual(keysOf(parseJson(sortJsonKeys(source))), ["a", "b", "z"]);
  assert.deepEqual(keysOf(at(parseJson(sortJsonKeys(source)), "a")), ["d", "c"]);
  assert.deepEqual(keysOf(at(parseJson(sortJsonKeys(source, 2)), "a")), ["c", "d"]);
  assert.deepEqual(at(parseJson(sortJsonKeys(source)), "z"), [3, 1]);
  assert.equal(sortJsonKeys('{"b":1,"a":2}'), '{\n  "a": 2,\n  "b": 1\n}\n');
});

await test("front matter and setext headings are not tables", () => {
  const front = "---\ntitle: Docs | Site\n---\n\n# Hi\n";
  assert.equal(alignMarkdownTables(front), front);
  const setext = "foo | bar\n---\n";
  assert.equal(alignMarkdownTables(setext), setext);
});

await test("an indented table keeps its indent and indented code stays code", () => {
  assert.equal(
    alignMarkdownTables("1. one\n\n   | a | bb |\n   |---|---|\n   | ccc | d |\n\n2. two\n"),
    "1. one\n\n   | a   | bb  |\n   | --- | --- |\n   | ccc | d   |\n\n2. two\n",
  );
  const code = "text\n\n    | a | b |\n    | - | - |\n";
  assert.equal(alignMarkdownTables(code), code);
});

await test("the header defines the table: mismatched delimiters are not tables and rows with extra cells are left alone", () => {
  const notTable = "a | b | c\n--- | ---\n";
  assert.equal(alignMarkdownTables(notTable), notTable);
  const extra = "| a | b |\n| - | - |\n| 1 | 2 | 3 |\n";
  assert.equal(alignMarkdownTables(extra), extra);
});

await test("CRLF files keep CRLF endings", () => {
  assert.equal(
    alignMarkdownTables("x\r\n\r\n| a | b |\r\n|---|---|\r\n"),
    "x\r\n\r\n| a   | b   |\r\n| --- | --- |\r\n",
  );
  assert.equal(alignKeyColumns("A x # 1\r\nLONG y # 2\r\n"), "A    x # 1\r\nLONG y # 2\r\n");
});

await test("a fence line with an info string does not close the fence", () => {
  const source = "```\n```js\n| a | bb |\n|---|---|\n```\n";
  assert.equal(alignMarkdownTables(source), source);
});

await test("JSON key sorting keeps raw values, orders integer-like keys by code point and keeps duplicates", () => {
  const out = sortJsonKeys(
    '{"b":1,"10":2,"9":3,"a":12345678901234567890,"c":1.0,"d":"\\u00e9","b":5}',
  );
  assert.equal(
    out,
    '{\n  "10": 2,\n  "9": 3,\n  "a": 12345678901234567890,\n  "b": 1,\n  "b": 5,\n  "c": 1.0,\n  "d": "\\u00e9"\n}\n',
  );
  assert.equal(sortJsonKeys('{"a":[],"b":{}}'), '{\n  "a": [],\n  "b": {}\n}\n');
  assert.throws(() => sortJsonKeys("{oops"));
});
