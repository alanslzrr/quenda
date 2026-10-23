// Calendar Date values are civil-day carriers, not reservation instants.
export function civilDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
export function calendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}
export function municipalToday(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((x) => x.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function slotLabel(instant: string, timeZone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

// Only repeated civil times need an offset in citizen-facing copy.
export function repeatedTime(instant: string, timeZone: string) {
  const stamp = (date: Date) =>
    new Intl.DateTimeFormat("sv", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  const date = new Date(instant);
  return [-120, -60, -30, 30, 60, 120].some(
    (minutes) =>
      stamp(new Date(date.getTime() + minutes * 60000)) === stamp(date),
  );
}
export function localTimeLabel(
  instant: string,
  timeZone: string,
  locale: string,
) {
  const label = slotLabel(instant, timeZone, locale);
  if (!repeatedTime(instant, timeZone)) return label;
  const offset =
    new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date(instant))
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  return `${label} (${offset.replace("GMT", "UTC")})`;
}
export function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest ? `${rest} min` : ""]
    .filter(Boolean)
    .join(" ");
}
export function durationOptions(calendar: {
  minimumMinutes: number;
  maximumMinutes: number;
  stepMinutes: number;
}) {
  const result: number[] = [];
  for (
    let n =
      Math.ceil(calendar.minimumMinutes / calendar.stepMinutes) *
      calendar.stepMinutes;
    n <= calendar.maximumMinutes && result.length < 48;
    n += calendar.stepMinutes
  )
    result.push(n);
  return result;
}
