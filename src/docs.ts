import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

import type { Diagnostic } from "./diagnostics.ts";
import { markdown, type Parsed } from "./docs-markdown.ts";
import { type DocsContext, type DocsPolicy, regions } from "./docs-regions.ts";
import { entry, incomplete, MARKDOWN, pad } from "./docs-rules.ts";
import { errorMessage } from "./errors.ts";
import { globMatches, isWithin, safePath } from "./files.ts";
import { type Execute, run } from "./process.ts";

export { fixDocs } from "./docs-regions.ts";
export { RULES } from "./docs-rules.ts";

function layout(
  {
    files,
    pages,
    reach,
  }: { files: readonly string[]; pages: readonly string[]; reach: Map<string, Set<string>> },
  { root, index, sections }: { root: string; index: string; sections: readonly string[] },
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const inside = files.filter((path) => path !== root && isWithin(root, path));
  const folders = new Set([root]);
  for (const file of inside) {
    for (
      let dir = posix.dirname(file);
      dir !== "." && dir !== root && isWithin(root, dir);
      dir = posix.dirname(dir)
    ) {
      folders.add(dir);
    }
  }
  const indexOf = (folder: string): string =>
    folder === root ? index : posix.join(folder, "index.md");
  const flagged = new Set<string>();
  for (const folder of folders) {
    if (folder !== root) {
      const top = (root === "." ? folder : folder.slice(root.length + 1)).split("/")[0];
      if (!sections.includes(top) && !flagged.has(top)) {
        flagged.add(top);
        diagnostics.push(
          entry("docs.layout", folder, `Folder ${top} is not a declared documentation section.`),
        );
      }
    }
    const page = indexOf(folder);
    if (!files.includes(page)) {
      diagnostics.push(entry("docs.layout", page, `Folder ${folder} needs an index.md.`));
      continue;
    }
    const linked = reach.get(page) ?? new Set();
    for (const file of files) {
      if (
        posix.dirname(file) === folder &&
        MARKDOWN.test(file) &&
        file !== page &&
        !linked.has(file)
      ) {
        diagnostics.push(entry("docs.index", page, `Missing guide ${file}.`));
      }
    }
    for (const child of folders) {
      if (child !== folder && posix.dirname(child) === folder && !linked.has(indexOf(child))) {
        diagnostics.push(entry("docs.index", page, `Missing folder index ${indexOf(child)}.`));
      }
    }
  }
  const linkedAll = new Set([...reach.values()].flatMap((set) => [...set]));
  for (const file of inside) {
    if (!MARKDOWN.test(file) && !linkedAll.has(file)) {
      diagnostics.push(
        entry("docs.layout", file, "Asset is not linked from any documentation page."),
      );
    }
  }
  if (files.includes(index)) {
    const seen = new Set([index]),
      queue = [index];
    for (const page of queue) {
      for (const target of reach.get(page) ?? []) {
        if (reach.has(target) && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    for (const page of pages) {
      if (isWithin(root, page) && !seen.has(page)) {
        diagnostics.push(entry("docs.layout", page, "Page is not reachable from the root index."));
      }
    }
  }
  return diagnostics;
}

export const governedPages = (config: DocsPolicy, files: readonly string[]): string[] => {
  const pages = new Set(files.filter((path) => MARKDOWN.test(path)));
  if (config.preset === "ozmikhail") {
    pages.add("AGENTS.md");
  }
  if (config.docs?.index) {
    pages.add(config.docs.index);
  }
  return [...pages].sort();
};

export const docsApplicable = (config: DocsPolicy): boolean =>
  config.preset === "ozmikhail" || config.docs !== undefined;

export async function checkDocs(
  { root, files, config, read: readFile }: DocsContext,
  { execute = run }: { execute?: Execute } = {},
): Promise<Diagnostic[]> {
  const read = (path: string): string => {
    const content = (readFile ?? ((file: string) => readFileSync(safePath(root, file), "utf8")))(
      path,
    );
    if (content === null) {
      throw new Error(`${path} is missing`);
    }
    return content;
  };
  const diagnostics: Diagnostic[] = [];
  const pages = governedPages(config, files);
  const base = config.docs?.root ?? (config.docs?.index ? posix.dirname(config.docs.index) : ".");
  const index = config.docs?.index ?? posix.join(base, "index.md");
  const documents = new Map<string, Parsed>();
  const get = (path: string): Parsed => {
    let document = documents.get(path);
    if (!document) {
      document = markdown(read(path));
      documents.set(path, document);
    }
    return document;
  };
  const reach = new Map<string, Set<string>>();
  if (config.docs !== undefined && !pages.some((path) => isWithin(base, path))) {
    diagnostics.push(
      incomplete("docs.scope", "plumb.json", `No Markdown files are governed under ${base}.`),
    );
  }
  for (const path of pages) {
    reach.set(path, new Set());
    let document: Parsed;
    try {
      document = get(path);
    } catch (error) {
      diagnostics.push(
        entry("docs.links", path, `Cannot read required documentation: ${errorMessage(error)}`),
      );
      continue;
    }
    for (const { rule, line, message, ...extra } of document.problems) {
      diagnostics.push(entry(rule, path, message, { line, ...extra }));
    }
    for (const { href, line } of document.links) {
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) {
        continue;
      }
      try {
        const hash = href.indexOf("#");
        const fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
        const location = decodeURIComponent(
          (hash < 0 ? href : href.slice(0, hash)).split("?", 1)[0] ?? "",
        );
        if (location.startsWith("/") || location.includes("\\")) {
          throw new Error("link paths must be relative URLs");
        }
        const target = location ? posix.normalize(posix.join(posix.dirname(path), location)) : path;
        const absolute = safePath(root, target);
        if (!existsSync(absolute)) {
          throw new Error("the target does not exist");
        }
        // a documentation folder is navigated through its index; a source folder has none and may
        // be linked as is
        if (
          statSync(absolute).isDirectory() &&
          (existsSync(`${absolute}/index.md`) ||
            existsSync(`${absolute}/README.md`) ||
            (base !== "." && isWithin(base, target)))
        ) {
          throw new Error("link the folder's index.md explicitly");
        }
        if (fragment && MARKDOWN.test(target) && !get(target).ids.has(fragment)) {
          throw new Error(`heading ${fragment} does not exist`);
        }
        reach.get(path)?.add(target);
      } catch (error) {
        diagnostics.push(entry("docs.links", path, `${href}: ${errorMessage(error)}`, { line }));
      }
    }
  }
  if (config.docs?.sections) {
    diagnostics.push(
      ...layout({ files, pages, reach }, { root: base, index, sections: config.docs.sections }),
    );
    // ozmikhail keeps AGENTS.md outside the documentation root, so the root index must still reach it
    if (
      config.preset === "ozmikhail" &&
      files.includes("AGENTS.md") &&
      !(reach.get(index) ?? new Set()).has("AGENTS.md")
    ) {
      diagnostics.push(entry("docs.index", index, "Missing guide AGENTS.md."));
    }
  } else if (config.docs?.index) {
    const folder = posix.dirname(index),
      indexed = reach.get(index) ?? new Set();
    for (const guide of pages) {
      if (
        guide !== index &&
        (folder === "." || guide.startsWith(`${folder}/`)) &&
        !indexed.has(guide)
      ) {
        diagnostics.push(entry("docs.index", index, `Missing guide ${guide}.`));
      }
    }
  }
  for (const kind of config.docs?.kinds ?? []) {
    const selected = pages.filter(
      (path) => globMatches(kind.files, path) && !globMatches(kind.exclude ?? [], path),
    );
    if (!selected.length) {
      diagnostics.push(
        incomplete(
          "docs.scope",
          "plumb.json",
          `No Markdown files match documentation kind ${kind.files.join(", ")}.`,
        ),
      );
      continue;
    }
    const sequence: { path: string; number: number }[] = [];
    for (const path of selected) {
      let document;
      try {
        document = get(path);
      } catch {
        continue;
      }
      if (kind.name && !new RegExp(kind.name).test(posix.basename(path))) {
        diagnostics.push(entry("docs.kinds", path, `The filename must match ${kind.name}.`));
      }
      const titles = document.headings
        .filter((heading) => heading.level === 2)
        .map((heading) => heading.text);
      let cursor = 0;
      for (const section of kind.sections ?? []) {
        // a Status line stands in for a Status section, so the status rule alone judges it
        if (
          section === "Status" &&
          kind.status &&
          document.lines.some((line) => /^Status:/.test(line))
        ) {
          continue;
        }
        const at = titles.indexOf(section, cursor);
        if (at < 0) {
          diagnostics.push(
            entry("docs.kinds", path, `Missing or out-of-order section ## ${section}.`),
          );
        } else {
          cursor = at + 1;
        }
      }
      const allowed = kind.status;
      if (allowed) {
        const inline = document.lines
          .map((line) => /^Status:\s*(\S.*?)\s*$/.exec(line)?.[1])
          .filter((value): value is string => !!value);
        const heading = document.headings.find(
          (item) => item.level === 2 && item.text === "Status",
        );
        const next = heading && document.lines.slice(heading.line).find((line) => line.trim());
        const section = next && !/^\s*#/.test(next) ? next.trim() : undefined;
        if (!inline.length && !heading) {
          diagnostics.push(
            entry("docs.kinds", path, `Status must be one of ${allowed.join(", ")}.`),
          );
        } else if (
          !inline.some((value) => allowed.includes(value)) &&
          !(section !== undefined && allowed.includes(section))
        ) {
          diagnostics.push(
            entry("docs.kinds", path, `Status must be one of ${allowed.join(", ")}.`),
          );
        }
      }
      if (kind.sequence) {
        const match = /^(\d{4})-/.exec(posix.basename(path));
        if (match) {
          sequence.push({ path, number: Number(match[1]) });
        } else {
          diagnostics.push(
            entry("docs.kinds", path, "Sequenced documents need a four-digit numeric prefix."),
          );
        }
      }
    }
    sequence.sort((a, b) => a.number - b.number || (a.path < b.path ? -1 : 1));
    let last = 0;
    for (const { path, number } of sequence) {
      if (number === last) {
        diagnostics.push(
          entry("docs.kinds", path, `Sequence number ${pad(number)} is duplicated.`),
        );
      } else if (number !== last + 1) {
        diagnostics.push(
          entry(
            "docs.kinds",
            path,
            `Sequence should continue at ${pad(last + 1)}, not ${pad(number)}.`,
          ),
        );
      }
      last = number;
    }
  }
  for (const region of await regions({ root, files, config }, execute)) {
    if ("problem" in region) {
      diagnostics.push(region.problem);
    } else if (region.drift) {
      diagnostics.push(
        entry(
          "docs.generated",
          region.path,
          `Region ${region.region} differs from the output of its pinned command.`,
          { line: region.line },
        ),
      );
    }
  }
  return diagnostics;
}
