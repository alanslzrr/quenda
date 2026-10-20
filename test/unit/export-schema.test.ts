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
    const relocated = {
      ...reservationExportExample.reservations[0],
      usageRulesUnitId: "00000000-0000-4000-8000-000000000004",
      usageRulesVersion: 1,
      usageRulesText: "Previously accepted rules",
      rulesAcceptedAt: "2030-01-01T00:00:00Z",
      pendingUsageRulesVersion: 2,
      pendingUsageRulesText: "Current unit rules awaiting acceptance",
    };
    assert.equal(
      (
        await validate({
          ...reservationExportExample,
          reservations: [relocated],
        })
      ).statusCode,
      200,
    );
    for (const field of [
      "usageRulesUnitId",
      "pendingUsageRulesVersion",
      "pendingUsageRulesText",
    ]) {
      const missing: Record<string, unknown> = { ...relocated };
      delete missing[field];
      assert.equal(
        (
          await validate({
            ...reservationExportExample,
            reservations: [missing],
          })
        ).statusCode,
        400,
      );
    }
    for (const payload of [
      { ...reservationExportExample, version: 2 },
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
      {
        ...reservationExportExample,
        reservations: [{ ...relocated, usageRulesUnitId: "invalid" }],
      },
      {
        ...reservationExportExample,
        reservations: [{ ...relocated, pendingUsageRulesVersion: 0 }],
      },
    ])
      assert.equal((await validate(payload)).statusCode, 400);
  } finally {
    await app.close();
  }
});
