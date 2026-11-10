import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";
import {
  calendarFile,
  fold,
} from "../../src/modules/reservations/icalendar.ts";

const stamp = new Date("2030-01-02T09:00:00Z");
const event = {
  uid: "00000000-0000-4000-8000-000000000002@quenda.test",
  startsAt: new Date("2030-01-05T10:00:00Z"),
  endsAt: new Date("2030-01-05T11:30:00Z"),
  sequence: 2,
  status: "CONFIRMED" as const,
  summary: "Reserva: Pista 1, Polideportivo; Oleiros",
  description: "Línea uno\nLínea dos con barra \\ y coma, final",
  location: "Rúa do Mar 4, 15001",
  geo: { latitude: 43.362346, longitude: -8.4115 },
  url: "https://quenda.test/reservas/t/r",
};

test("the file is a strict RFC 5545 calendar that an independent parser reads back", () => {
  const text = calendarFile([event], { name: "Mis reservas", stamp });
  assert.ok(text.endsWith("\r\n"));
  assert.ok(!/(^|[^\r])\n/.test(text), "every line ends with CRLF");
  for (const line of text.split("\r\n"))
    assert.ok(new TextEncoder().encode(line).length <= 75, line);
  const root = new ICAL.Component(ICAL.parse(text));
  assert.equal(root.getFirstPropertyValue("version"), "2.0");
  const [vevent] = root.getAllSubcomponents("vevent");
  assert.ok(vevent);
  const parsed = new ICAL.Event(vevent);
  assert.equal(parsed.uid, event.uid);
  assert.equal(
    parsed.startDate.toJSDate().toISOString(),
    "2030-01-05T10:00:00.000Z",
  );
  assert.equal(
    parsed.endDate.toJSDate().toISOString(),
    "2030-01-05T11:30:00.000Z",
  );
  assert.equal(parsed.summary, event.summary);
  assert.ok(
    text.includes("SUMMARY:Reserva: Pista 1\\, Polideportivo\\; Oleiros"),
    "commas and semicolons are escaped in text values",
  );
  assert.equal(parsed.description, event.description);
  assert.equal(parsed.location, event.location);
  assert.equal(vevent.getFirstPropertyValue("sequence"), 2);
  assert.equal(vevent.getFirstPropertyValue("status"), "CONFIRMED");
  assert.deepEqual(vevent.getFirstProperty("geo")?.getValues(), [
    [43.362346, -8.4115],
  ]);
});

test("a cancellation keeps the identity and raises the sequence so calendars replace the event", () => {
  const first = calendarFile([event], { name: "x", stamp });
  const cancelled = calendarFile(
    [{ ...event, sequence: 3, status: "CANCELLED" as const }],
    { name: "x", stamp },
  );
  assert.ok(
    first.includes(`UID:${event.uid}`) &&
      cancelled.includes(`UID:${event.uid}`),
  );
  assert.ok(
    cancelled.includes("STATUS:CANCELLED") && cancelled.includes("SEQUENCE:3"),
  );
});

test("long lines fold on character boundaries and unfold to the original", () => {
  const long = `SUMMARY:${"ñandú ".repeat(40)}final`;
  const folded = fold(long);
  assert.ok(folded.length > 1);
  for (const line of folded)
    assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.ok(folded.slice(1).every((line) => line.startsWith(" ")));
  assert.equal(
    folded.map((line, i) => (i ? line.slice(1) : line)).join(""),
    long,
  );
  assert.deepEqual(fold("SHORT:value"), ["SHORT:value"]);
});

test("an empty calendar and optional fields are valid too", () => {
  const empty = calendarFile([], { name: "Vacío", stamp });
  assert.equal(
    new ICAL.Component(ICAL.parse(empty)).getAllSubcomponents("vevent").length,
    0,
  );
  const minimal = calendarFile(
    [
      {
        uid: "u@x",
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        sequence: 1,
        status: "CONFIRMED",
        summary: "S",
      },
    ],
    { name: "m", stamp },
  );
  assert.ok(!minimal.includes("LOCATION") && !minimal.includes("GEO"));
  assert.doesNotThrow(() => ICAL.parse(minimal));
});
