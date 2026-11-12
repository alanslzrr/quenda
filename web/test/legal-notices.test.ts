import assert from "node:assert/strict";
import test from "node:test";
import {
  kinds,
  noticeApi,
  noticeFields,
  noticePath,
  pick,
} from "../src/features/legal/notices.ts";
import {
  accessibilityText,
  legalText,
  privacyText,
  type Text,
} from "../src/features/legal/standard-text.ts";

test("text follows the active language and falls back to the other co-official one", () => {
  const body = {
    gl: { controller: "Concello" },
    es: { controller: "Ayuntamiento", dpo: "  " },
  };
  assert.equal(pick(body, "gl", "controller"), "Concello");
  assert.equal(pick(body, "es", "controller"), "Ayuntamiento");
  assert.equal(pick({ es: { dpo: "Delegado" } }, "gl", "dpo"), "Delegado");
  assert.equal(pick(body, "es", "dpo"), undefined);
  assert.equal(pick({}, "es", "controller"), undefined);
});

test("municipal and instance texts have distinct pages and endpoints", () => {
  const tenant = "00000000-0000-4000-8000-000000000001";
  assert.equal(noticePath("privacy"), "/privacidad");
  assert.equal(
    noticePath("legal", tenant),
    `/municipios/${tenant}/aviso-legal`,
  );
  assert.equal(noticePath("accessibility"), "/accesibilidad");
  assert.equal(noticeApi("privacy"), "/api/public/notices/privacy");
  assert.equal(
    noticeApi("accessibility", tenant),
    `/api/public/municipalities/${tenant}/notices/accessibility`,
  );
});

test("every kind defines labeled fields in both languages", () => {
  for (const kind of kinds) {
    assert.ok(noticeFields[kind].length > 0, kind);
    const keys = noticeFields[kind].map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, kind);
    for (const field of noticeFields[kind])
      assert.ok(field.label[0] && field.label[1], field.key);
  }
});

test("the standard wording exists in Spanish and Galician and names no placeholder", () => {
  const texts: Text[] = [
    ...privacyText.data,
    ...Object.values(privacyText).filter(
      (value): value is Text => typeof value[0] === "string",
    ),
    ...Object.values(legalText),
    ...accessibilityText.design,
    accessibilityText.commitment(undefined),
    accessibilityText.commitment("Concello de Oleiros"),
    accessibilityText.feedback,
    accessibilityText.enforcement,
  ];
  for (const [es, gl] of texts) {
    assert.ok(es.trim() && gl.trim(), es);
    assert.notEqual(es, gl, es);
    assert.doesNotMatch(
      `${es} ${gl}`,
      /[Pp]endiente|[Pp]endente|\[|\]|XXX|\bTODO\b/,
    );
  }
  assert.match(
    accessibilityText.commitment("Concello de Oleiros")[0],
    /^Concello de Oleiros se compromete/,
  );
});

test("the privacy information names what the municipality must provide", () => {
  const keys = noticeFields.privacy.map((field) => field.key);
  for (const required of [
    "controller",
    "purposes",
    "legalBasis",
    "retention",
    "rights",
    "complaint",
  ])
    assert.ok(keys.includes(required), required);
});
