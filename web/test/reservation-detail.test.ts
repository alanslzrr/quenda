import assert from "node:assert/strict";
import test from "node:test";
import {
  cancellation,
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

test("cancellation is offered to the holder until the deadline and explained afterwards", () => {
  const start = Date.parse("2030-01-10T10:00:00Z");
  const reservation = {
    status: "CONFIRMADA" as const,
    startsAt: new Date(start).toISOString(),
    cancellationMinutes: 60,
  };
  const deadline = start - 3600000;
  assert.equal(cancellation(reservation, true, deadline), "allowed");
  assert.equal(cancellation(reservation, true, deadline + 1), "closed");
  assert.equal(cancellation(reservation, true, start), "closed");
  assert.equal(cancellation(reservation, false, deadline - 1), "closed");
  assert.equal(
    cancellation({ ...reservation, status: "FINALIZADA" }, true, deadline - 1),
    "closed",
  );
  // Cancelled elsewhere while the dialog was open: it says so instead of offering the action again.
  assert.equal(
    cancellation({ ...reservation, status: "CANCELADA" }, true, deadline - 1),
    "cancelled",
  );
});
