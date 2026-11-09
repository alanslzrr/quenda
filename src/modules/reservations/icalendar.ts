export interface CalendarEvent {
  /** Stable identity: the same reservation always yields the same UID, so a re-import updates instead of duplicating. */
  uid: string;
  startsAt: Date;
  endsAt: Date;
  /** Reservation revision; a higher number replaces the previous version of the event in the calendar. */
  sequence: number;
  status: "CONFIRMED" | "CANCELLED";
  summary: string;
  description?: string | undefined;
  location?: string | undefined;
  geo?: { latitude: number; longitude: number } | undefined;
  url?: string | undefined;
}

// RFC 5545 section 3.3.11: backslash, semicolon, comma and line breaks are escaped in text values.
function escapeText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", ";")
    .replaceAll(",", "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}
function utc(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}
// Lines are limited to 75 octets; continuations start with one space. Cuts never split a UTF-8 character.
export function fold(line: string): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return [line];
  const parts: string[] = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      parts.push(current);
      current = " ";
      size = 1;
      limit = 75;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts;
}

/** A VCALENDAR with the given events. Times are written in UTC, so no time zone definitions are needed. */
export function calendarFile(
  events: readonly CalendarEvent[],
  options: { name: string; stamp: Date; product?: string },
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${options.product ?? "-//Quenda//Reservas//ES"}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(options.name)}`,
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${utc(options.stamp)}`,
      `DTSTART:${utc(event.startsAt)}`,
      `DTEND:${utc(event.endsAt)}`,
      `SEQUENCE:${event.sequence}`,
      `STATUS:${event.status}`,
      `SUMMARY:${escapeText(event.summary)}`,
    );
    if (event.description)
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.geo)
      lines.push(`GEO:${event.geo.latitude};${event.geo.longitude}`);
    if (event.url) lines.push(`URL:${event.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.flatMap(fold).join("\r\n")}\r\n`;
}
