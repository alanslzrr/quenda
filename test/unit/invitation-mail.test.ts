import assert from "node:assert/strict";
import test from "node:test";
import {
  type InvitationMailEvent,
  invitationMail,
} from "../../src/modules/communications/invitation-mail.ts";

const municipal: InvitationMailEvent = {
  kind: "MANAGER",
  municipality: "Concello de Proba",
  timeZone: "Europe/Madrid",
  expiresAt: "2030-10-26T22:30:00Z",
};
const expected = {
  es: {
    subject: "Quenda — Invitación pendiente",
    roles: {
      ADMINISTRATOR: "administrar el municipio Concello de Proba",
      MANAGER: "gestionar el municipio Concello de Proba",
      OPERATOR: "operar la plataforma Quenda",
      PRIVACY:
        "ejercer permisos de privacidad sobre la identidad global en Quenda",
    },
    deadline: "Plazo para aceptarla: 27/10/2030, 00:30 GMT+02:00",
    zone: "Zona horaria: Europe/Madrid",
    path: "«Mi cuenta › Invitaciones»",
    mfa: "verificación en dos pasos",
    ignore: "Si no la esperabas, puedes ignorar este mensaje.",
  },
  gl: {
    subject: "Quenda — Invitación pendente",
    roles: {
      ADMINISTRATOR: "administrar o municipio Concello de Proba",
      MANAGER: "xestionar o municipio Concello de Proba",
      OPERATOR: "operar a plataforma Quenda",
      PRIVACY:
        "exercer permisos de privacidade sobre a identidade global en Quenda",
    },
    deadline: "Prazo para aceptala: 27/10/2030, 00:30 GMT+02:00",
    zone: "Fuso horario: Europe/Madrid",
    path: "«A miña conta › Invitacións»",
    mfa: "verificación en dous pasos",
    ignore: "Se non a agardabas, podes ignorar esta mensaxe.",
  },
} as const;

test("invitation notices name the role, scope and deadline in Spanish and Galician", () => {
  for (const locale of ["es", "gl"] as const) {
    const copy = expected[locale];
    for (const kind of [
      "ADMINISTRATOR",
      "MANAGER",
      "OPERATOR",
      "PRIVACY",
    ] as const) {
      const platform = kind === "OPERATOR" || kind === "PRIVACY";
      const event: InvitationMailEvent = {
        ...municipal,
        kind,
        ...(platform ? { municipality: null, timeZone: "UTC" } : {}),
      };
      const before = structuredClone(event);
      const message = invitationMail(
        "person@example.test",
        "https://quenda.test",
        locale,
        event,
      );
      assert.deepEqual(event, before);
      assert.equal(message.to, "person@example.test");
      assert.equal(message.subject, copy.subject);
      assert.ok(message.text.includes(copy.roles[kind]), `${locale} ${kind}`);
      if (!platform) {
        assert.ok(message.text.includes(copy.deadline), message.text);
        assert.ok(message.text.includes(copy.zone));
      } else assert.match(message.text, /: UTC$/m);
      assert.ok(message.text.includes(copy.path));
      assert.ok(message.text.includes(copy.mfa));
      assert.ok(message.text.includes(copy.ignore));
      assert.match(
        message.text,
        /^https:\/\/quenda\.test\/perfil\/invitaciones$/m,
      );
      // Nothing identifies the inviter, an account or the invitation itself.
      assert.ok(!message.text.includes("person@example.test"));
      assert.doesNotMatch(message.text, /[0-9a-f]{8}-[0-9a-f]{4}-/);
      assert.doesNotMatch(message.text, /[?&#]/);
    }
  }
});
test("the notice is identical for every recipient of the same invitation data", () => {
  const first = invitationMail(
    "registered@example.test",
    "https://quenda.test",
    "es",
    municipal,
  );
  const second = invitationMail(
    "unknown@example.test",
    "https://quenda.test",
    "es",
    municipal,
  );
  assert.equal(first.subject, second.subject);
  assert.equal(first.text, second.text);
});
test("a municipality name is kept on one line", () => {
  const message = invitationMail(
    "person@example.test",
    "https://quenda.test",
    "gl",
    {
      ...municipal,
      municipality: "  Concello\nde\tProba  ",
    },
  );
  assert.ok(message.text.includes("xestionar o municipio Concello de Proba."));
});
test("invalid recipients, origins and events are rejected before sending", () => {
  const send = (
    to: string,
    origin: string,
    event: Partial<InvitationMailEvent> = {},
  ) =>
    invitationMail(to, origin, "es", {
      ...municipal,
      ...event,
    } as InvitationMailEvent);
  assert.throws(() => send("person", "https://quenda.test"), /recipient/);
  assert.throws(
    () =>
      send("person@example.test\nBcc: x@example.test", "https://quenda.test"),
    /recipient/,
  );
  for (const origin of [
    "ftp://quenda.test",
    "https://user:pass@quenda.test",
    "https://quenda.test/path",
    "https://quenda.test/?q=1",
  ])
    assert.throws(() => send("person@example.test", origin), /origin/);
  for (const event of [
    { kind: "UNKNOWN" as InvitationMailEvent["kind"] },
    { municipality: null },
    { municipality: "   " },
    { municipality: "x".repeat(201) },
    { expiresAt: "2030-10-26" },
    { expiresAt: "not a date" },
    { timeZone: "Mars/Olympus" },
  ])
    assert.throws(
      () => send("person@example.test", "https://quenda.test", event),
      /Invalid invitation event/,
      JSON.stringify(event),
    );
});
