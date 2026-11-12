import assert from "node:assert/strict";
import test from "node:test";
import { describeShares, splitBarText } from "../src/ui/split-bar/labels.ts";

test("the split bar reads every share with its count", () => {
  const es = splitBarText("es");
  assert.equal(
    describeShares(
      "Reservas",
      [
        { label: "No canceladas", share: "80 %", count: "40 reservas" },
        {
          label: "Canceladas por el ayuntamiento",
          share: "0 %",
          count: "0 reservas",
        },
      ],
      es.keyHint,
    ),
    "Reservas: No canceladas, 80 %, 40 reservas; Canceladas por el ayuntamiento, 0 %, 0 reservas. Usa las flechas para leer cada parte.",
  );
  assert.equal(
    splitBarText("gl").hidden("Canceladas"),
    "Canceladas: non se mostra.",
  );
});
