import assert from "node:assert/strict";
import test from "node:test";
import { toCsv } from "../../src/modules/communications/csv.ts";

test("the file is RFC 4180: BOM, header, CRLF and quoted special characters", () => {
  const csv = toCsv(
    ["id", "note"],
    [
      { id: 1, note: 'say "hi", please' },
      { id: 2, note: "two\nlines" },
      { id: 3, note: null },
    ],
  );
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(
    csv.slice(1),
    'id,note\r\n1,"say ""hi"", please"\r\n2,"two\nlines"\r\n3,\r\n',
  );
});

test("values that a spreadsheet would run as a formula are neutralised", () => {
  const rows = [
    "=1+1",
    "+SUM(A1)",
    "-2+3",
    "@cmd",
    "\tTAB",
    '=HYPERLINK("http://x","y")',
  ].map((value) => ({ value }));
  const lines = toCsv(["value"], rows)
    .slice(1)
    .trimEnd()
    .split("\r\n")
    .slice(1);
  for (const line of lines)
    assert.ok(line.startsWith("'") || line.startsWith(`"'`), line);
  // Numbers and booleans are data, not text, and stay as they are.
  assert.equal(
    toCsv(["n", "b"], [{ n: -5, b: false }])
      .trimEnd()
      .split("\r\n")[1],
    "-5,false",
  );
  assert.equal(
    toCsv(["a"], [{ a: "plain text" }])
      .trimEnd()
      .split("\r\n")[1],
    "plain text",
  );
});

test("an empty result is just the header", () => {
  assert.equal(toCsv(["a", "b"], []), "﻿a,b\r\n");
});
