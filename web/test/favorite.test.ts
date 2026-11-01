import assert from "node:assert/strict";
import test from "node:test";
import { readFavorite, saveFavorite } from "../src/app/favorite.ts";

const tenant = "00000000-0000-4000-8000-000000000001";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test("the favourite municipality round-trips and can be cleared", () => {
  const storage = memory();
  assert.equal(readFavorite(storage), null);
  saveFavorite(storage, tenant);
  assert.equal(readFavorite(storage), tenant);
  saveFavorite(storage, null);
  assert.equal(readFavorite(storage), null);
});

test("a stored value that is not a municipality id is ignored, not followed", () => {
  const storage = memory();
  storage.setItem("quenda.municipality", "../administracion");
  assert.equal(readFavorite(storage), null);
});

test("unavailable storage leaves booking without a favourite instead of failing", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readFavorite(broken), null);
  assert.doesNotThrow(() => saveFavorite(broken, tenant));
  assert.equal(readFavorite(undefined), null);
});
