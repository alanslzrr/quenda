export interface Interval {
  startMinute: number;
  endMinute: number;
}
export interface UnitCalendar {
  minimumMinutes: number;
  maximumMinutes: number;
  stepMinutes: number;
  advanceDays: number | null;
  weekly: (Interval & { day: number })[];
  exceptions: { date: string; intervals: Interval[] }[];
}
export const emptyCalendar: UnitCalendar = {
  minimumMinutes: 30,
  maximumMinutes: 120,
  stepMinutes: 30,
  advanceDays: null,
  weekly: [],
  exceptions: [],
};
export function minuteLabel(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
export function parseMinute(value: string, end = false) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) && !(end && value === "24:00"))
    return null;
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
