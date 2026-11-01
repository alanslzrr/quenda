import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { civilDate, civilMonth } from "../../src/shared/civil-date.ts";
import { trustedProxies } from "../../src/trusted-proxies.ts";

test("civil inputs reject year zero and impossible dates before SQL", () => {
  for (const value of ["0000-01-01", "2026-02-30", "2026-13-01", "10000-01-01"])
    assert.throws(() => civilDate(value), { code: "INVALID_INPUT" });
  for (const value of ["0000-01", "2026-13", "2026-1"])
    assert.throws(() => civilMonth(value), { code: "INVALID_INPUT" });
  for (const value of ["0001-01-01", "9999-12-31", "2024-02-29"])
    assert.equal(civilDate(value), value);
});
test("proxy configuration is opt-in and rejects universal or malformed trust", () => {
  assert.deepEqual(trustedProxies(undefined), []);
  assert.deepEqual(trustedProxies("127.0.0.1, ::1/128"), [
    "127.0.0.1",
    "::1/128",
  ]);
  assert.deepEqual(
    trustedProxies("0:0:0:0:0:0:0:1/128,2001:db8::/32,10.0.0.0/8"),
    ["0:0:0:0:0:0:0:1/128", "2001:db8::/32", "10.0.0.0/8"],
  );
  for (const value of [
    "true",
    "*",
    "loopback",
    "0.0.0.0/0",
    "::/0",
    "127.0.0.1/33",
    "127.0.0.1,",
    "::1/129",
    "fe80::1%eth0",
    "0.0.0.0/1,128.0.0.0/1",
    "::ffff:0.0.0.0/96",
    "::/1",
  ])
    assert.throws(() => trustedProxies(value));
});
test("only trusted peers resolve forwarded clients; forged prefixes do not override the nearest untrusted peer", async () => {
  for (const trustedProxyCidrs of [[], ["127.0.0.1/32"]]) {
    const app = await buildApp({
      trustedProxyCidrs,
      database: { check: async () => {}, close: async () => {} },
      logLevel: "silent",
    });
    app.get("/test-peer", (request) => ({ ip: request.ip }));
    try {
      const response = await app.inject({
        url: "/test-peer",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "192.0.2.99, 192.0.2.2" },
      });
      assert.equal(
        response.json().ip,
        trustedProxyCidrs.length ? "192.0.2.2" : "127.0.0.1",
      );
      const direct = await app.inject({
        url: "/test-peer",
        remoteAddress: "192.0.2.3",
        headers: { "x-forwarded-for": "192.0.2.99" },
      });
      assert.equal(direct.json().ip, "192.0.2.3");
    } finally {
      await app.close();
    }
  }
});

test("public search reads each calendar only once in its transaction", async () => {
  const { publicAvailabilitySearch, candidateAvailability } = await import(
    "../../src/modules/catalog/public.ts"
  );
  const calls: string[] = [];
  const rows = Array.from({ length: 21 }, (_, i) => ({
    id: String(i),
    name: `Unit ${i}`,
    facility_name: "Facility",
  }));
  const client = {
    release() {},
    async query(sql: string, values: unknown[] = []) {
      calls.push(sql);
      if (sql.includes("public_search_units")) return { rows };
      if (sql.includes("public_unit_calendar"))
        return {
          rows: [
            {
              id: values[1],
              name: "Unit",
              facility_id: "facility",
              facility_name: "Facility",
              timezone: "Europe/Madrid",
              municipal_advance_days: 30,
              cancellation_minutes: 0,
              booking_policy_version: 1,
              usage_rules_version: 1,
              version: 1,
              calendar: {
                minimumMinutes: 60,
                maximumMinutes: 120,
                stepMinutes: 60,
                advanceDays: null,
                weekly: [{ day: 1, startMinute: 540, endMinute: 1260 }],
                exceptions: [],
              },
            },
          ],
        };
      if (sql.includes("public_available_slots"))
        return { rows: [{ slot_index: 1 }] };
      return { rows: [] };
    },
  };
  const pool = { connect: async () => client } as unknown as import("pg").Pool;
  const result = await publicAvailabilitySearch(
    pool,
    "tenant",
    "2026-11-02",
    60,
    null,
    { now: () => new Date("2026-10-29T00:00:00Z") },
  );
  assert.equal(result.items.length, 20);
  assert.equal(result.nextCursor, "19");
  assert.equal(
    calls.filter((sql) => sql.includes("public_unit_calendar")).length,
    20,
  );
  assert.equal(
    calls.filter((sql) => sql.includes("domain.public_")).length,
    41,
  );
  assert.equal(calls[0], "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.equal(calls.at(-1), "COMMIT");
  const candidate = await candidateAvailability(
    client as unknown as import("pg").PoolClient,
    "tenant",
    "0",
    "2026-11-02",
    60,
    { now: () => new Date("2026-10-29T00:00:00Z") },
  );
  assert.deepEqual(result.items[0]?.slots, candidate.slots.slice(0, 1));
  assert.equal(result.items[0]?.unitId, candidate.unitId);
  assert.equal(result.items[0]?.calendarVersion, candidate.calendarVersion);
});
