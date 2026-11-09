const limit = 100;

// A contract tool lists operations by summary, so each one needs a short line even when
// the route only documents itself in a long description.
export function operationSummary(schema: {
  summary?: string;
  description?: string;
  operationId?: string;
}): string {
  if (schema.summary?.trim()) return schema.summary.trim();
  const sentence = (schema.description ?? "")
    .trim()
    .split(/(?<=[.!?])\s+/, 1)[0]
    ?.replace(/[.!?]+$/, "")
    .trim();
  if (sentence) {
    if (sentence.length <= limit) return sentence;
    const cut = sentence.slice(0, limit - 1);
    return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : cut.length)}…`;
  }
  const words = (schema.operationId ?? "operation")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
