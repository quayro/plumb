import path from "node:path";

export const rulesRelativeTo = (root: string, filename: string): string =>
  path.relative(root, filename).split(path.sep).join("/");

export const rulesReasoned = <T extends { reason?: unknown }>(entries: T[], label: string): T[] => {
  for (const entry of entries) {
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new TypeError(`${label}: every exception states its reason`);
    }
  }
  return entries;
};
