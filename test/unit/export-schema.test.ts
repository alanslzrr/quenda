import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  reservationExportExample,
  reservationExportSchema,
} from "../../src/modules/communications/export-schema.ts";

test("reservation export schema validates the example and rejects incompatible documents", async () => {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.post(
    "/validate",
    { schema: { body: reservationExportSchema } },
    async () => ({ valid: true }),
  );
  try {
    const validate = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/validate",
        payload: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
    assert.equal((await validate(reservationExportExample)).statusCode, 200);
    for (const payload of [
      { ...reservationExportExample, version: 3 },
      { ...reservationExportExample, password: "secret" },
      { ...reservationExportExample, tenantId: "invalid" },
      { ...reservationExportExample, entities: ["users"] },
      {
        ...reservationExportExample,
        period: { ...reservationExportExample.period, from: "invalid" },
      },
      {
        ...reservationExportExample,
        reservations: [
          {
            ...reservationExportExample.reservations[0],
            email: "private@example.test",
          },
        ],
      },
      {
        ...reservationExportExample,
        reservations: [
          { ...reservationExportExample.reservations[0], status: "UNKNOWN" },
        ],
      },
    ])
      assert.equal((await validate(payload)).statusCode, 400);
  } finally {
    await app.close();
  }
});
