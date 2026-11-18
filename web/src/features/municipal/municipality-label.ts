import { compareText } from "../../ui/lib/intl-cache.ts";

const same = (a: string, b: string) =>
  compareText(a.trim(), b.trim(), "es", { sensitivity: "base" }) === 0;

/** Municipal names are not unique, so a repeated name carries the end of its id to stay distinguishable. */
export function municipalityLabel(
  municipality: { id: string; name: string },
  all: readonly { id: string; name: string }[],
) {
  const repeated = all.some(
    (other) =>
      other.id !== municipality.id && same(other.name, municipality.name),
  );
  return repeated
    ? `${municipality.name} · ${municipality.id.slice(-6)}`
    : municipality.name;
}
