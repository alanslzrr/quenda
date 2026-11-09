import { facilityProfileSchema, unitProfileSchema } from "./profile-schema.ts";

const uuid = { type: "string", format: "uuid" } as const;
const instant = { type: "string", format: "date-time" } as const;
const nullableInstant = { ...instant, nullable: true } as const;
const interval = {
  type: "object",
  additionalProperties: false,
  required: ["startMinute", "endMinute"],
  properties: {
    startMinute: { type: "integer", minimum: 0, maximum: 1439 },
    endMinute: { type: "integer", minimum: 1, maximum: 1440 },
  },
} as const;

export const catalogExportSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Quenda catalog export v1",
  type: "object",
  additionalProperties: false,
  required: [
    "format",
    "version",
    "tenantId",
    "generatedAt",
    "municipality",
    "facilities",
    "units",
  ],
  properties: {
    format: { type: "string", enum: ["quenda.catalog"] },
    version: { type: "integer", enum: [1] },
    tenantId: uuid,
    generatedAt: instant,
    municipality: {
      type: "object",
      additionalProperties: false,
      required: ["name", "timeZone", "bookingPolicy", "appearance"],
      properties: {
        name: { type: "string" },
        timeZone: { type: "string" },
        bookingPolicy: {
          type: "object",
          additionalProperties: false,
          required: ["version", "advanceDays", "cancellationMinutes"],
          properties: {
            version: { type: "integer", minimum: 1 },
            advanceDays: { type: "integer", minimum: 0 },
            cancellationMinutes: { type: "integer", minimum: 0 },
          },
        },
        appearance: {
          type: "object",
          additionalProperties: false,
          required: ["lightPalette", "darkPalette", "defaultTheme"],
          properties: {
            lightPalette: { type: "string" },
            darkPalette: { type: "string" },
            defaultTheme: { type: "string", enum: ["light", "dark"] },
          },
        },
      },
    },
    facilities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "publishedAt", "withdrawnAt", "profile"],
        properties: {
          id: uuid,
          name: { type: "string" },
          publishedAt: nullableInstant,
          withdrawnAt: nullableInstant,
          profile: facilityProfileSchema,
        },
      },
    },
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "facilityId",
          "name",
          "publishedAt",
          "withdrawnAt",
          "profile",
          "calendar",
          "usageRules",
        ],
        properties: {
          id: uuid,
          facilityId: uuid,
          name: { type: "string" },
          publishedAt: nullableInstant,
          withdrawnAt: nullableInstant,
          profile: unitProfileSchema,
          calendar: {
            nullable: true,
            type: "object",
            additionalProperties: false,
            required: [
              "version",
              "minimumMinutes",
              "maximumMinutes",
              "stepMinutes",
              "advanceDays",
              "weekly",
              "exceptions",
            ],
            properties: {
              version: { type: "integer", minimum: 1 },
              minimumMinutes: { type: "integer", minimum: 1 },
              maximumMinutes: { type: "integer", minimum: 1 },
              stepMinutes: { type: "integer", minimum: 1 },
              advanceDays: { type: "integer", minimum: 0, nullable: true },
              weekly: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["day", "startMinute", "endMinute"],
                  properties: {
                    day: { type: "integer", minimum: 1, maximum: 7 },
                    startMinute: interval.properties.startMinute,
                    endMinute: interval.properties.endMinute,
                  },
                },
              },
              exceptions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["date", "intervals"],
                  properties: {
                    date: { type: "string", format: "date" },
                    intervals: { type: "array", items: interval },
                  },
                },
              },
            },
          },
          usageRules: {
            nullable: true,
            type: "object",
            additionalProperties: false,
            required: ["version", "text"],
            properties: {
              version: { type: "integer", minimum: 1 },
              text: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

export const catalogExportExample = {
  format: "quenda.catalog",
  version: 1,
  tenantId: "00000000-0000-4000-8000-000000000001",
  generatedAt: "2030-01-02T00:00:00Z",
  municipality: {
    name: "Concello de exemplo",
    timeZone: "Europe/Madrid",
    bookingPolicy: { version: 1, advanceDays: 30, cancellationMinutes: 1440 },
    appearance: {
      lightPalette: "neutral",
      darkPalette: "neutral",
      defaultTheme: "light",
    },
  },
  facilities: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Polideportivo",
      publishedAt: "2029-12-01T10:00:00Z",
      withdrawnAt: null,
      profile: { address: "Rúa do Mar 4", postalCode: "15001" },
    },
  ],
  units: [
    {
      id: "00000000-0000-4000-8000-000000000003",
      facilityId: "00000000-0000-4000-8000-000000000002",
      name: "Pista 1",
      publishedAt: "2029-12-01T10:00:00Z",
      withdrawnAt: null,
      profile: { kind: "padel", indoor: false, capacity: 4 },
      calendar: {
        version: 1,
        minimumMinutes: 60,
        maximumMinutes: 120,
        stepMinutes: 60,
        advanceDays: null,
        weekly: [{ day: 1, startMinute: 480, endMinute: 1200 }],
        exceptions: [],
      },
      usageRules: { version: 1, text: "Respeta el horario reservado." },
    },
  ],
} as const;
