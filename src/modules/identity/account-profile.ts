export const accountProfileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

export function normalizedAccountName(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "name") return null;
  const name = (body as { name: unknown }).name;
  if (typeof name !== "string" || name.length > 200) return null;
  const normalized = name.trim();
  return normalized &&
    ![...normalized].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
    ? normalized
    : null;
}
