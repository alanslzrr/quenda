import assert from "node:assert/strict";
import test from "node:test";
import {
  placeContext,
  placeUnitName,
} from "../src/features/reservations/detail-model.ts";

test("the reservation names its space from the detail, falling back only when the name is missing", () => {
  const place = {
    municipalityName: "Oleiros",
    facilityName: "Pavillón municipal",
    unitName: "Pista 1",
  };
  assert.equal(placeUnitName(place, "Espacio reservado"), "Pista 1");
  assert.equal(placeContext(place), "Oleiros · Pavillón municipal");
  assert.equal(
    placeContext(place, "Reserva actual"),
    "Reserva actual · Oleiros · Pavillón municipal",
  );
  for (const unitName of [null, undefined, "", "  "])
    assert.equal(
      placeUnitName({ ...place, unitName }, "Espacio reservado"),
      "Espacio reservado",
    );
  assert.equal(
    placeContext({ municipalityName: "Oleiros", facilityName: null }),
    "Oleiros",
  );
  assert.equal(placeContext({}, "Reserva actual"), "Reserva actual");
});
