import assert from "node:assert/strict";
import test from "node:test";
import { isChunkError, mayReloadOnce } from "../src/app/chunk-reload.ts";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("lazy chunk failures are recognised across browsers and ordinary errors are not", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: https://x/assets/a.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
  ])
    assert.equal(isChunkError(new TypeError(message)), true);
  const named = new Error("x");
  named.name = "ChunkLoadError";
  assert.equal(isChunkError(named), true);
  assert.equal(
    isChunkError(new TypeError("Cannot read properties of null")),
    false,
  );
  assert.equal(isChunkError("boom"), false);
});

test("an automatic reload happens once per window and never without storage", () => {
  const storage = memory();
  assert.equal(mayReloadOnce(storage, 1_000), true);
  assert.equal(mayReloadOnce(storage, 5_000), false);
  assert.equal(mayReloadOnce(storage, 12_000), true);
  assert.equal(mayReloadOnce(undefined, 1_000), false);
  assert.equal(
    mayReloadOnce(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("full");
        },
      },
      1_000,
    ),
    false,
  );
});
