import assert from "node:assert/strict";
import test from "node:test";
import { baseText } from "../src/features/legal/base-text.ts";
import {
  kinds,
  noticeApi,
  noticeFields,
  noticePath,
  pick,
} from "../src/features/legal/notices.ts";

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

test("every kind defines labeled fields and platform text in both languages", () => {
  for (const kind of kinds) {
    assert.ok(noticeFields[kind].length > 0, kind);
    const keys = noticeFields[kind].map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, kind);
    for (const field of noticeFields[kind])
      assert.ok(field.label[0] && field.label[1], field.key);
    for (const locale of ["es", "gl"] as const)
      assert.ok(baseText[kind][locale].length > 0, `${kind} ${locale}`);
    assert.equal(baseText[kind].es.length, baseText[kind].gl.length, kind);
  }
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
