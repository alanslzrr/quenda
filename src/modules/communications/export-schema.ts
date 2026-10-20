const uuid = { type: "string", format: "uuid" };
const date = { type: "string", format: "date" };
const instant = { type: "string", format: "date-time" };
const reservation = {
  usageRulesUnitId: {
    description:
      "Unidad de las normas aceptadas; puede diferir de unitId después de una reubicación.",
    anyOf: [uuid, { type: "null" }],
  },
  usageRulesText: { anyOf: [{ type: "string" }, { type: "null" }] },
  usageRulesVersion: {
    anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
  },
  rulesAcceptedAt: { anyOf: [instant, { type: "null" }] },
  pendingUsageRulesVersion: {
    description:
      "Versión de las normas de unitId pendiente de aceptación; no modifica el estado de la reserva.",
    anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
  },
  pendingUsageRulesText: { anyOf: [{ type: "string" }, { type: "null" }] },
  bookingPolicyVersion: {
    anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
  },
  conditionsAcceptedAt: { anyOf: [instant, { type: "null" }] },
  nonCancellableAccepted: { anyOf: [{ type: "boolean" }, { type: "null" }] },
  id: uuid,
  unitId: uuid,
  accountId: { type: "string", minLength: 1 },
  startsAt: instant,
  endsAt: instant,
  status: { type: "string", enum: ["CONFIRMADA", "CANCELADA", "FINALIZADA"] },
  revision: { type: "integer", minimum: 1 },
  calendarVersion: { type: "integer", minimum: 1 },
  cancellationMinutes: { type: "integer", minimum: 0 },
  timeZone: { type: "string", minLength: 1 },
};
export const reservationExportSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Quenda reservation export v3",
  type: "object",
  additionalProperties: false,
  required: [
    "format",
    "version",
    "tenantId",
    "unitId",
    "generatedAt",
    "period",
    "entities",
    "reservations",
  ],
  properties: {
    format: { type: "string", const: "quenda.reservations" },
    version: { type: "integer", const: 3 },
    tenantId: uuid,
    unitId: { anyOf: [uuid, { type: "null" }] },
    generatedAt: instant,
    period: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to", "timeZone", "selection"],
      properties: {
        from: date,
        to: date,
        timeZone: { type: "string", minLength: 1 },
        selection: { type: "string", const: "overlap" },
      },
    },
    entities: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: { type: "string", const: "reservations" },
    },
    reservations: {
      type: "array",
      maxItems: 10000,
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(reservation),
        properties: reservation,
      },
    },
  },
};
export const reservationExportExample = {
  format: "quenda.reservations",
  version: 3,
  tenantId: "00000000-0000-4000-8000-000000000001",
  unitId: null,
  generatedAt: "2030-01-02T00:00:00Z",
  period: {
    from: "2030-01-01",
    to: "2030-01-02",
    timeZone: "Europe/Madrid",
    selection: "overlap",
  },
  entities: ["reservations"],
  reservations: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      unitId: "00000000-0000-4000-8000-000000000003",
      accountId: "synthetic-account",
      usageRulesUnitId: null,
      usageRulesText: null,
      usageRulesVersion: null,
      rulesAcceptedAt: null,
      pendingUsageRulesVersion: null,
      pendingUsageRulesText: null,
      bookingPolicyVersion: null,
      conditionsAcceptedAt: null,
      nonCancellableAccepted: null,
      startsAt: "2030-01-01T10:00:00Z",
      endsAt: "2030-01-01T11:00:00Z",
      status: "FINALIZADA",
      revision: 1,
      calendarVersion: 1,
      cancellationMinutes: 60,
      timeZone: "Europe/Madrid",
    },
  ],
};
