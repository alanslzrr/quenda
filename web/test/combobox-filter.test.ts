import assert from "node:assert/strict";
import test from "node:test";
import {
  type ComboboxOption,
  filterOptions,
  normalizeSearch,
  orderedOptions,
  sectionOptions,
} from "../src/ui/combobox/filter.ts";

const spaces: ComboboxOption[] = [
  { value: "a", label: "Pista central", group: "Pavillón municipal" },
  {
    value: "b",
    label: "Ximnasio",
    group: "Pavillón municipal",
    hint: "retirado",
  },
  { value: "c", label: "Sala de reunións", group: "Casa da cultura" },
  { value: "d", label: "Pista exterior", group: "Pavillón municipal" },
  { value: "e", label: "Auditorio" },
];

test("search ignores case and accents", () => {
  assert.equal(normalizeSearch("  Pavillón "), "pavillon");
  assert.deepEqual(
    filterOptions(spaces, "PAVILLON").map((option) => option.value),
    ["a", "b", "d"],
  );
  assert.deepEqual(
    filterOptions(spaces, "reunions").map((option) => option.value),
    ["c"],
  );
});

test("search also finds options by their hint and keywords", () => {
  assert.deepEqual(
    filterOptions(spaces, "retirado").map((option) => option.value),
    ["b"],
  );
  assert.deepEqual(
    filterOptions(
      [{ value: "x", label: "Sala 1", keywords: ["planta baixa"] }],
      "baixa",
    ).map((option) => option.value),
    ["x"],
  );
  assert.equal(filterOptions(spaces, "").length, spaces.length);
});

test("options are listed under their group headings in first-appearance order", () => {
  const sections = sectionOptions(spaces);
  assert.deepEqual(
    sections.map((section) => [
      section.group,
      section.options.map(({ option, index }) => `${option.value}${index}`),
    ]),
    [
      ["Pavillón municipal", ["a0", "b1", "d2"]],
      ["Casa da cultura", ["c3"]],
      [undefined, ["e4"]],
    ],
  );
  assert.deepEqual(
    orderedOptions(sections).map((option) => option.value),
    ["a", "b", "d", "c", "e"],
  );
});

test("filtering keeps headings only for groups with matches", () => {
  const sections = sectionOptions(filterOptions(spaces, "pista"));
  assert.deepEqual(
    sections.map((section) => section.group),
    ["Pavillón municipal"],
  );
  assert.deepEqual(sectionOptions(filterOptions(spaces, "nada")), []);
});
