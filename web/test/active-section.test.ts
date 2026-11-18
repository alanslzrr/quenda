import assert from "node:assert/strict";
import test from "node:test";
import { activeSection } from "../src/features/municipal/active-section.ts";

const base = "/administracion/m1";
const ids = [base, `${base}/agenda`, `${base}/personal`, `${base}/convenios`];

test("management navigation highlights the section that owns the page", () => {
  assert.equal(activeSection(ids, base, base), base);
  assert.equal(activeSection(ids, `${base}/instalaciones/f1`, base), base);
  assert.equal(activeSection(ids, `${base}/unidades/u1`, base), base);
  assert.equal(
    activeSection(ids, `${base}/personal/invitar`, base),
    `${base}/personal`,
  );
  assert.equal(
    activeSection(ids, `${base}/convenios/a1/versiones/1`, base),
    `${base}/convenios`,
  );
  assert.equal(
    activeSection(ids, `${base}/reservas/r1`, base),
    `${base}/agenda`,
  );
});

test("a page outside the listed sections highlights none of them", () => {
  // An administrator without privacy permissions opening «Conservación».
  assert.equal(activeSection(ids, `${base}/privacidad/politicas`, base), "");
  assert.equal(activeSection(ids, `${base}/apariencia`, base), "");
});
