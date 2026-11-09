const text = { type: "string" } as const;
const localized = {
  type: "object",
  additionalProperties: false,
  properties: { gl: text, es: text },
} as const;

export const unitKinds = [
  "polideportiva",
  "pabellon",
  "futbol",
  "tenis",
  "padel",
  "piscina",
  "sala",
  "gimnasio",
  "atletismo",
  "otro",
] as const;
export type UnitKind = (typeof unitKinds)[number];

// Same shape on read and write, so a client can read a profile, edit it and send it back.
const facilityProperties = {
  address: { type: "string", minLength: 1, maxLength: 300 },
  postalCode: { type: "string", pattern: "^[0-9]{5}$" },
  location: {
    type: "object",
    additionalProperties: false,
    required: ["latitude", "longitude"],
    properties: {
      latitude: { type: "number", minimum: -90, maximum: 90 },
      longitude: { type: "number", minimum: -180, maximum: 180 },
    },
  },
  description: localized,
  accessibility: localized,
  contact: {
    type: "object",
    additionalProperties: false,
    properties: { phone: text, email: text },
  },
} as const;
const unitProperties = {
  kind: { type: "string", enum: unitKinds },
  indoor: { type: "boolean" },
  capacity: { type: "integer", minimum: 1, maximum: 10000 },
  description: localized,
} as const;

export const facilityProfileSchema = {
  type: "object",
  additionalProperties: false,
  properties: facilityProperties,
} as const;
export const unitProfileSchema = {
  type: "object",
  additionalProperties: false,
  properties: unitProperties,
} as const;
export const facilityProfileBody = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion"],
  properties: {
    expectedVersion: { type: "integer", minimum: 1, maximum: 2147483646 },
    ...facilityProperties,
  },
} as const;
export const unitProfileBody = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion"],
  properties: {
    expectedVersion: { type: "integer", minimum: 1, maximum: 2147483646 },
    ...unitProperties,
  },
} as const;
