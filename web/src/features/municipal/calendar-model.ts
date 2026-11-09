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

export type CalendarProblem =
  | "range"
  | "step"
  | "advance"
  | "overlap"
  | "exceptionOverlap";

/** Mirrors the rules the server enforces so a violation is explained before submitting. */
export function calendarProblem(calendar: {
  minimumMinutes: number;
  maximumMinutes: number;
  stepMinutes: number;
  advanceDays: number | null;
  weekly: (Interval & { day: number })[];
  exceptions: { date: string; intervals: Interval[] }[];
}): CalendarProblem | null {
  const whole = (value: number) => Number.isInteger(value) && value > 0;
  const {
    minimumMinutes: min,
    maximumMinutes: max,
    stepMinutes: step,
  } = calendar;
  if (!whole(min) || !whole(max) || !whole(step) || min > max) return "range";
  if (min % step !== 0 || max % step !== 0) return "step";
  if (
    calendar.advanceDays !== null &&
    (!Number.isInteger(calendar.advanceDays) || calendar.advanceDays < 0)
  )
    return "advance";
  const overlaps = (intervals: Interval[]) => {
    const sorted = [...intervals].sort((a, b) => a.startMinute - b.startMinute);
    return sorted.some(
      (current, index) =>
        index > 0 && current.startMinute < (sorted[index - 1]?.endMinute ?? 0),
    );
  };
  for (let day = 1; day <= 7; day += 1)
    if (overlaps(calendar.weekly.filter((row) => row.day === day)))
      return "overlap";
  if (calendar.exceptions.some((exception) => overlaps(exception.intervals)))
    return "exceptionOverlap";
  return null;
}

/** A duration is admissible when it is a whole multiple of the step inside the unit's limits. */
export function admissibleDuration(
  text: string,
  calendar: {
    minimumMinutes: number;
    maximumMinutes: number;
    stepMinutes: number;
  },
) {
  if (!/^[1-9][0-9]{0,5}$/.test(text)) return null;
  const minutes = Number(text);
  return minutes >= calendar.minimumMinutes &&
    minutes <= calendar.maximumMinutes &&
    minutes % calendar.stepMinutes === 0
    ? minutes
    : null;
}
