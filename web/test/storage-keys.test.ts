import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { storageEntries } from "../src/app/storage-keys.ts";

// "quenda.personal-data" names the downloaded file format; it is never written to storage.
const notStorage = new Set(["quenda.personal-data"]);

test("every browser storage key the code uses is described on the privacy page", async () => {
  const used = new Set<string>();
  const root = path.resolve("src");
  for (const file of await readdir(root, { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(file) || file.endsWith("storage-keys.ts")) continue;
    const source = await readFile(path.join(root, file), "utf8");
    for (const match of source.matchAll(/["'`](quenda\.[a-z][a-z-]*)/g))
      if (match[1] && !notStorage.has(match[1])) used.add(match[1]);
  }
  assert.ok(used.size >= 4, "the scan finds the keys in use");
  const described = new Set(storageEntries.map((entry) => entry.key));
  for (const key of used)
    assert.ok(described.has(key), `${key} is used but not described`);
});

test("every described key has an explanation and a lifetime in both languages", () => {
  const keys = new Set<string>();
  for (const entry of storageEntries) {
    assert.ok(!keys.has(entry.key), `${entry.key} is listed twice`);
    keys.add(entry.key);
    for (const text of [...entry.purpose, ...entry.duration])
      assert.ok(text.trim().length > 10, entry.key);
    assert.notEqual(entry.purpose[0], entry.purpose[1]);
  }
});
