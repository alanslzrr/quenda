import { dateTimeFormat } from "../../ui/lib/intl-cache.ts";

// Resolve a civil minute in the named municipal zone, not the browser zone.
// Round-tripping rejects DST gaps; repeated minutes remain two explicit choices.
export function localInstants(
  value: string,
  timeZone: string,
): { utc: string; offset: string }[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return [];
  const guess = Date.parse(`${value}:00Z`);
  if (
    !Number.isFinite(guess) ||
    new Date(guess).toISOString().slice(0, 16) !== value
  )
    return [];
  const fmt = dateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const civil = (instant: number) => {
    const p = Object.fromEntries(
      fmt.formatToParts(instant).map((p) => [p.type, p.value]),
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = guess + hours * 3600000;
    offsets.add(Date.parse(`${civil(sample)}:00Z`) - sample);
  }
  return [...offsets]
    .map((offset) => ({ instant: guess - offset, offset }))
    .filter((x) => civil(x.instant) === value)
    .sort((a, b) => a.instant - b.instant)
    .map((x) => {
      const minutes = Math.abs(x.offset) / 60000;
      return {
        utc: new Date(x.instant).toISOString(),
        offset: `${x.offset < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
      };
    });
}
