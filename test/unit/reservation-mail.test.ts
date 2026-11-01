import assert from "node:assert/strict";
import test from "node:test";
import {
  type ReservationMailEvent,
  reservationMail,
} from "../../src/modules/communications/reservation-mail.ts";

const event: ReservationMailEvent = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  reservationId: "00000000-0000-4000-8000-000000000002",
  revision: 2,
  kind: "MODIFICADA",
  occurredAt: "2030-10-26T12:00:00Z",
  startsAt: "2030-10-27T00:30:00Z",
  endsAt: "2030-10-27T01:30:00Z",
  timeZone: "Europe/Madrid",
  unitId: "00000000-0000-4000-8000-000000000003",
  pendingUsageRulesVersion: null,
};
test("reservation messages localize all events and distinguish history from current state", () => {
  for (const locale of ["es", "gl"] as const)
    for (const kind of ["CONFIRMADA", "MODIFICADA", "CANCELADA"] as const) {
      const data = { ...event, kind },
        before = structuredClone(data);
      const message = reservationMail(
        "citizen@example.test",
        "https://quenda.test",
        locale,
        data,
      );
      assert.deepEqual(data, before);
      assert.equal(message.to, "citizen@example.test");
      assert.match(
        message.subject,
        /^Quenda — Reserva (confirmada|modificada|cancelada)$/,
      );
      assert.match(message.text, /Revisión: 2/);
      assert.ok(
        message.text.includes(
          locale === "gl" ? "Data do evento" : "Fecha del evento",
        ),
      );
      assert.ok(
        message.text.includes(
          locale === "gl" ? "pode ter cambiado" : "puede haber cambiado",
        ),
      );
      assert.match(
        message.text,
        /https:\/\/quenda\.test\/reservas\/00000000-0000-4000-8000-000000000001\/00000000-0000-4000-8000-000000000002/,
      );
      assert.match(message.text, /GMT\+02:00/);
      assert.match(message.text, /GMT\+01:00/);
      assert.ok(!("html" in message));
      assert.doesNotMatch(message.text, /Normas (pendientes|pendentes)/);
    }
});
test("reservation mail rejects invalid origins, recipients and event payloads", () => {
  for (const origin of [
    "javascript:alert(1)",
    "https://user:pass@quenda.test",
    "https://quenda.test/path",
    "https://quenda.test?token=secret",
  ])
    assert.throws(() =>
      reservationMail("user@example.test", origin, "es", event),
    );
  for (const to of ["invalid", "user@example.test\r\nBcc: other@example.test"])
    assert.throws(() =>
      reservationMail(to, "https://quenda.test", "es", event),
    );
  for (const patch of [
    { revision: 0 },
    { startsAt: "2030-02-30T00:00:00Z" },
    { timeZone: "Invalid/Zone" },
    { startsAt: "2030-10-27T00:30:00" },
    { endsAt: event.startsAt },
    { tenantId: "../other" },
    { unitId: "../other" },
    { pendingUsageRulesVersion: 0 },
    { pendingUsageRulesVersion: 1.5 },
    { pendingUsageRulesVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() =>
      reservationMail("user@example.test", "https://quenda.test", "es", {
        ...event,
        ...patch,
      }),
    );
});

test("relocation mail identifies pending rules without treating them as accepted", () => {
  for (const locale of ["es", "gl"] as const) {
    const data = { ...event, pendingUsageRulesVersion: 7 };
    const before = structuredClone(data);
    const message = reservationMail(
      "citizen@example.test",
      "https://quenda.test",
      locale,
      data,
    );
    assert.deepEqual(data, before);
    assert.match(message.text, /Normas (pendientes|pendentes) de aceptación/);
    assert.ok(message.text.includes(`: ${event.unitId}`));
    assert.match(message.text, /Versión (de las|das) normas: 7/);
    assert.doesNotMatch(message.text, /normas aceptadas|reserva pendiente/i);
    const cancelled = reservationMail(
      "citizen@example.test",
      "https://quenda.test",
      locale,
      { ...data, kind: "CANCELADA" },
    );
    assert.doesNotMatch(cancelled.text, /Normas (pendientes|pendentes)/);
  }
});

test("rendered reservation messages use the existing private local transport", async () => {
  const { mkdtemp, readdir, readFile, stat, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localMail } = await import("../../src/mail/local.ts");
  const root = await mkdtemp(join(tmpdir(), "quenda-reservation-mail-"));
  try {
    const directory = join(root, "mail");
    const message = reservationMail(
      "citizen@example.test",
      "https://quenda.test",
      "gl",
      event,
    );
    await localMail(directory).send(message);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const file = join(directory, files[0] as string);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), message);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
