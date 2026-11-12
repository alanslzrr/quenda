import assert from "node:assert/strict";
import test from "node:test";
import { chartText, withUnit } from "../src/ui/lib/chart-text.ts";

test("charts name missing values and their own controls in both languages", () => {
  const gl = chartText("gl");
  const es = chartText("es");
  assert.equal(gl.noData, "sen datos");
  assert.equal(es.average, "Media");
  assert.equal(gl.explore("Ocupación", "Data"), "Ocupación: explorar por data");
  assert.equal(es.span("1 mar", "31 mar"), "desde 1 mar hasta 31 mar");
  assert.equal(
    gl.latestValue("Ocupación", "40 %", "12 mar"),
    "Ocupación, último valor 40 % (12 mar)",
  );
  assert.equal(es.seriesShown(1, 2), "1 de 2 series visibles");
  assert.equal(withUnit("40", "%"), "40 %");
  assert.equal(withUnit("40"), "40");
});
