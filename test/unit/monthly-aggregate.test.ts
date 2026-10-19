import assert from "node:assert/strict";
import test from "node:test";
import {
  assessMonthlyAggregate,
  type MonthlyAggregateInput,
} from "../../src/modules/collaboration/monthly-aggregate.ts";

function fixture(): MonthlyAggregateInput {
  return {
    month: "2030-03",
    timeZone: "Europe/Madrid",
    asOf: "2030-03-31T22:00:00Z",
    participants: ["a", "b"],
    scopes: ["a", "b"].map((tenantId) => ({
      tenantId,
      unitId: "unit",
      start: "2030-02-28T23:00:00Z",
      end: "2030-03-31T22:00:00Z",
    })),
    reservations: ["a", "b"].flatMap((tenantId) =>
      Array.from({ length: 10 }, (_, i) => ({
        tenantId,
        unitId: "unit",
        reservationId: `r${i}`,
        subjectId: `s${i}`,
        start: "2030-03-10T10:00:00Z",
        end: "2030-03-10T11:00:00Z",
        released: false,
      })),
    ),
  };
}
test("monthly threshold counts distinct subjects per municipality and never substitutes zero for suppression", () => {
  const input = fixture();
  assert.deepEqual(assessMonthlyAggregate(input), {
    status: "THRESHOLD_MET",
    reservations: 20,
    reservedMinutes: 1200,
  });
  assert.deepEqual(
    assessMonthlyAggregate({
      ...input,
      reservations: input.reservations.slice(1),
    }),
    { status: "NOT_PUBLISHABLE" },
  );
  assert.deepEqual(
    assessMonthlyAggregate({
      ...input,
      reservations: input.reservations.map((r) => ({
        ...r,
        subjectId: "same",
      })),
    }),
    { status: "NOT_PUBLISHABLE" },
  );
  assert.deepEqual(
    assessMonthlyAggregate({ ...input, participants: ["a", "b", "empty"] }),
    { status: "NOT_PUBLISHABLE" },
  );
  assert.deepEqual(
    assessMonthlyAggregate({
      ...input,
      reservations: input.reservations.map((r) => ({
        ...r,
        released: r.tenantId === "b",
      })),
    }),
    { status: "NOT_PUBLISHABLE" },
  );
  assert.deepEqual(
    assessMonthlyAggregate({ ...input, scopes: [], reservations: [] }),
    { status: "NOT_PUBLISHABLE" },
  );
});
test("monthly aggregates clip effective scopes and month, merge overlap, and use civil DST boundaries", () => {
  const input = fixture();
  const spanning = input.reservations.map((r) => ({
    ...r,
    start: "2030-02-28T22:00:00Z",
    end: "2030-04-01T00:00:00Z",
  }));
  const whole = assessMonthlyAggregate({
    ...input,
    reservations: spanning,
    scopes: [...input.scopes, ...input.scopes],
  });
  assert.deepEqual(whole, {
    status: "THRESHOLD_MET",
    reservations: 0,
    reservedMinutes: 20 * (31 * 24 - 1) * 60,
  });
  const scoped = {
    ...input,
    scopes: input.scopes.map((s) => ({
      ...s,
      start: "2030-03-10T10:30:00Z",
      end: "2030-03-10T10:45:00Z",
    })),
  };
  assert.deepEqual(assessMonthlyAggregate(scoped), {
    status: "THRESHOLD_MET",
    reservations: 0,
    reservedMinutes: 300,
  });
  assert.deepEqual(
    assessMonthlyAggregate({
      ...input,
      reservations: input.reservations.map((r) => ({
        ...r,
        start: input.scopes[0]!.end,
        end: "2030-04-01T01:00:00Z",
      })),
    }),
    { status: "NOT_PUBLISHABLE" },
  );
});
test("monthly assessment rejects open months, duplicate projections, invalid scope and dates", () => {
  const input = fixture();
  for (const invalid of [
    { ...input, asOf: "2030-03-31T21:59:59Z" },
    { ...input, month: "2030-13" },
    { ...input, timeZone: "+01:00" },
    { ...input, participants: ["a", "a"] },
    { ...input, reservations: [...input.reservations, input.reservations[0]!] },
    { ...input, scopes: [{ ...input.scopes[0]!, tenantId: "foreign" }] },
  ])
    assert.throws(() => assessMonthlyAggregate(invalid), {
      code: "INVALID_INPUT",
    });
});
