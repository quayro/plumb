interface XmlNode {
  tag: string;
  name: string;
  attrs: Record<string, string | undefined>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) {
    throw new Error("Unknown XML entity in test report");
  }
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_all, entity: string) => {
    if (!entity.startsWith("#")) {
      return ENTITIES[entity.toLowerCase()] ?? "";
    }
    const hex = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      throw new Error("Invalid XML character");
    }
    return String.fromCodePoint(point);
  });
}

// this bounded parser accepts the JUnit report vocabulary, with no DTDs or external entities.
export function parseJUnit(source: string): TestCase[] {
  if (Buffer.byteLength(source) > 16 * 1024 * 1024) {
    throw new Error("Verification report exceeds 16 MiB");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new Error("DTD and entity declarations are not accepted in test reports");
  }
  const stack: XmlNode[] = [],
    roots: XmlNode[] = [];
  let offset = 0,
    nodes = 0;
  const appendText = (text: string, raw = false): void => {
    const current = stack.at(-1);
    if (!current) {
      if (text.trim()) {
        throw new Error("Text outside the JUnit document");
      }
      return;
    }
    current.text += raw ? text : decode(text);
  };
  while (offset < source.length) {
    if (source[offset] !== "<") {
      const end = source.indexOf("<", offset);
      appendText(source.slice(offset, end < 0 ? source.length : end));
      offset = end < 0 ? source.length : end;
      continue;
    }
    if (
      source.startsWith("<!--", offset) ||
      source.startsWith("<![CDATA[", offset) ||
      source.startsWith("<?xml", offset)
    ) {
      const cdata = source.startsWith("<![CDATA[", offset),
        comment = source.startsWith("<!--", offset);
      const close = cdata ? "]]>" : comment ? "-->" : "?>",
        start = offset + (cdata ? 9 : comment ? 4 : 5),
        end = source.indexOf(close, start);
      if (end < 0) {
        throw new Error("Unclosed XML section");
      }
      if (cdata) {
        appendText(source.slice(start, end), true);
      } else if (!comment && (roots.length || stack.length)) {
        throw new Error("Misplaced XML declaration");
      }
      offset = end + close.length;
      continue;
    }
    let end = offset + 1,
      quote: string | undefined;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) {
          quote = undefined;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end === source.length) {
      throw new Error("Unclosed XML tag");
    }
    const token = source.slice(offset + 1, end),
      close = /^\/\s*([\w:.-]+)\s*$/.exec(token);
    offset = end + 1;
    if (close) {
      if (stack.pop()?.tag !== close[1]) {
        throw new Error("Mismatched JUnit closing tag");
      }
      continue;
    }
    const opened = /^([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)$/.exec(token);
    if (!opened) {
      throw new Error("Invalid JUnit tag");
    }
    const [, tag = "", raw = "", empty] = opened,
      name = tag.split(":").at(-1) ?? tag,
      attrs: Record<string, string | undefined> = {};
    let rest = raw;
    while (rest.trim()) {
      const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (
        !attribute ||
        !attribute[1] ||
        ["__proto__", "constructor", "prototype"].includes(attribute[1]) ||
        Object.hasOwn(attrs, attribute[1])
      ) {
        throw new Error("Malformed or duplicate JUnit attribute");
      }
      attrs[attribute[1]] = decode(attribute[2] ?? attribute[3] ?? "");
      rest = rest.slice(attribute[0].length);
    }
    if (++nodes > 100000 || stack.length > 128) {
      throw new Error("JUnit report exceeds structural limits");
    }
    const node: XmlNode = { tag, name, attrs, children: [], text: "" },
      parent = stack.at(-1);
    const children: Record<string, string[]> = {
      testsuites: ["testsuite", "testcase", "properties", "system-out", "system-err"],
      testsuite: ["testsuite", "testcase", "properties", "system-out", "system-err"],
      testcase: ["failure", "error", "skipped", "properties", "system-out", "system-err"],
      properties: ["property"],
    };
    const allowed = parent ? (children[parent.name] ?? []) : ["testsuites", "testsuite"];
    if (!allowed.includes(name)) {
      throw new Error(`Unsupported JUnit element ${name}`);
    }
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    if (!empty) {
      stack.push(node);
    }
  }
  if (stack.length || roots.length !== 1) {
    throw new Error("Incomplete JUnit document");
  }
  const cases: TestCase[] = [];
  const visit = (node: XmlNode, parents: string[] = []): void => {
    if (node.name === "testcase") {
      if (!node.attrs.name) {
        throw new Error("JUnit test case needs a name");
      }
      if (
        node.attrs.status &&
        !["run", "passed", "failed", "skipped", "notrun", "disabled"].includes(node.attrs.status)
      ) {
        throw new Error("Unsupported JUnit test status");
      }
      const failed =
        node.children.some((child) => ["failure", "error"].includes(child.name)) ||
        node.attrs.status === "failed";
      const skipped =
        node.children.some((child) => child.name === "skipped") ||
        ["skipped", "notrun", "disabled"].includes(node.attrs.status ?? "");
      if (failed && skipped) {
        throw new Error("JUnit case cannot be both failed and skipped");
      }
      const status: TestCase["status"] = failed ? "failed" : skipped ? "skipped" : "passed";
      cases.push({
        id: [...parents, node.attrs.file, node.attrs.classname, node.attrs.name]
          .filter(Boolean)
          .join("/"),
        status,
        ...(failed
          ? {
              message: node.children
                .filter((child) => ["failure", "error"].includes(child.name))
                .map((child) => child.attrs.message ?? child.text)
                .join("\n")
                .slice(0, 8192),
            }
          : {}),
      });
      return;
    }
    const start = cases.length;
    for (const child of node.children) {
      visit(child, [
        ...parents,
        ...(node.name === "testsuite" && node.attrs.name ? [node.attrs.name] : []),
      ]);
    }
    if (!["testsuite", "testsuites"].includes(node.name)) {
      return;
    }
    const rows = cases.slice(start),
      counts = {
        tests: rows.length,
        skipped: rows.filter((row) => row.status === "skipped").length,
      };
    for (const [key, expected] of Object.entries(counts)) {
      const count = node.attrs[key];
      if (count !== undefined && (!/^\d+$/.test(count) || Number(count) !== expected)) {
        throw new Error(`JUnit ${key} count contradicts its test cases`);
      }
    }
    if (["failures", "errors"].some((key) => node.attrs[key] !== undefined)) {
      for (const key of ["failures", "errors"]) {
        const count = node.attrs[key];
        if (count !== undefined && !/^\d+$/.test(count)) {
          throw new Error("Invalid JUnit failure count");
        }
      }
      if (
        Number(node.attrs.failures ?? 0) + Number(node.attrs.errors ?? 0) !==
        rows.filter((row) => row.status === "failed").length
      ) {
        throw new Error("JUnit failure counts contradict its test cases");
      }
    }
  };
  const [root] = roots;
  if (root) {
    visit(root);
  }
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("Duplicate JUnit test case identity");
  }
  return cases;
}

export interface TestCase {
  id: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
}
