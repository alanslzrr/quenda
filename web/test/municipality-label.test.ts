import assert from "node:assert/strict";
import test from "node:test";
import { municipalityLabel } from "../src/features/municipal/municipality-label.ts";

const first = { id: "11111111-1111-4111-8111-111111111111", name: "Oleiros" };
const second = {
  id: "22222222-2222-4222-8222-222222222222",
  name: " oleiros ",
};
const other = { id: "33333333-3333-4333-8333-333333333333", name: "Arteixo" };

test("a name used once is shown unchanged", () => {
  assert.equal(municipalityLabel(other, [first, second, other]), "Arteixo");
  assert.equal(municipalityLabel(first, [first]), "Oleiros");
});

test("homonymous municipalities are told apart by the end of their id", () => {
  const all = [first, second, other];
  assert.equal(municipalityLabel(first, all), "Oleiros · 111111");
  assert.equal(municipalityLabel(second, all), " oleiros  · 222222");
});
