import assert from "node:assert/strict";
import test from "node:test";
import {
  minuteLabel,
  parseMinute,
} from "../src/features/municipal/calendar-model.ts";
import { localInstants } from "../src/features/municipal/local-instants.ts";
import {
  commandResultPath,
  commandReviewPath,
  type PendingCommand,
} from "../src/features/reservations/commands.ts";

test("calendar end-of-day is explicit and invalid clock fields are not coerced", () => {
  assert.equal(minuteLabel(1440), "24:00");
  assert.equal(parseMinute("24:00"), null);
  assert.equal(parseMinute("24:00", true), 1440);
  assert.equal(parseMinute("09:30"), 570);
  for (const v of ["", "9:30", "12:60", "25:00", "09:30extra"])
    assert.equal(parseMinute(v, true), null);
});
test("municipal civil times reject gaps and retain both offsets of repeated hours", () => {
  assert.deepEqual(localInstants("2026-03-29T02:30", "Europe/Madrid"), []);
  assert.deepEqual(localInstants("2026-10-25T02:30", "Europe/Madrid"), [
    { utc: "2026-10-25T00:30:00.000Z", offset: "+02:00" },
    { utc: "2026-10-25T01:30:00.000Z", offset: "+01:00" },
  ]);
  assert.equal(localInstants("2026-02-30T12:00", "Europe/Madrid").length, 0);
  assert.deepEqual(localInstants("2026-10-22T12:00", "Asia/Kathmandu"), [
    { utc: "2026-10-22T06:15:00.000Z", offset: "+05:45" },
  ]);
});
test("command recovery returns to the corresponding municipal or personal context", () => {
  const item: PendingCommand = {
    owner: "a",
    path: "/api/municipalities/tenant/reservations/id/modify",
    body: '{"administrative":true}',
    key: "key",
    createdAt: 0,
    retentionSeconds: 60,
  };
  assert.equal(commandReviewPath(item), "/administracion/tenant/agenda");
  assert.equal(
    commandResultPath(item, { tenantId: "tenant", id: "id" }),
    "/administracion/tenant/reservas/id",
  );
  assert.equal(
    commandResultPath(
      { ...item, path: "/api/municipalities/tenant/blocks" },
      { tenantId: "tenant", id: "block" },
    ),
    "/administracion/tenant/agenda",
  );
  assert.equal(
    commandResultPath(
      { ...item, body: "{}" },
      { tenantId: "tenant", id: "id" },
    ),
    "/reservas/tenant/id",
  );
});
