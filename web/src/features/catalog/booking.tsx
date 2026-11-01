import { ArrowLeft, CalendarDays, Clock3 } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { usePreferences } from "../../app/preferences-provider";
import { DatePicker } from "../../ui/date-picker/date-picker";
import { Input } from "../../ui/input/input";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import { Select } from "../../ui/select/select";
import styles from "./booking.module.css";
import {
  calendarDate,
  civilDate,
  durationLabel,
  endsNextDay,
  municipalToday,
  repeatedTime,
  resolveBookingDate,
  timeRange,
} from "./dates";

export interface Slot {
  start: { utc: string; local: string };
  end: { utc: string; local: string };
}

/** Date, duration and facility travel in the URL so later steps never ask again. */
export function useBookingParams(timeZone: string) {
  const [search, setSearch] = useSearchParams();
  const today = municipalToday(timeZone);
  const requested = search.get("fecha") ?? "";
  const duration = Number(search.get("duracion")) || undefined;
  const update = (changes: Record<string, string | undefined>) =>
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes))
          if (value) next.set(key, value);
          else next.delete(key);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  return {
    today,
    ...resolveBookingDate(requested, today),
    duration,
    facility: search.get("instalacion") ?? "",
    update,
  };
}
export function bookingQuery(values: {
  date?: string;
  duration?: number;
  facility?: string;
}) {
  const query = new URLSearchParams();
  if (values.date) query.set("fecha", values.date);
  if (values.duration) query.set("duracion", String(values.duration));
  if (values.facility) query.set("instalacion", values.facility);
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function BackLink({ to, children }: { to: string; children: string }) {
  return (
    <Link className={styles.back} to={to}>
      <ArrowLeft size={16} aria-hidden="true" />
      {children}
    </Link>
  );
}

export function DateField({
  date,
  today,
  maxDays,
  onChange,
}: {
  date: string;
  today: string;
  maxDays?: number;
  onChange: (date: string) => void;
}) {
  const { locale, t } = usePreferences();
  const minimum = calendarDate(today);
  const maximum =
    maxDays === undefined
      ? undefined
      : new Date(
          minimum.getFullYear(),
          minimum.getMonth(),
          minimum.getDate() + maxDays,
          12,
        );
  return (
    <DatePicker
      label={t("Día", "Día")}
      calendarLabel={t("Elegir día", "Escoller día")}
      locale={locale}
      value={calendarDate(date)}
      today={minimum}
      minDate={minimum}
      maxDate={maximum}
      formatValue={(value) =>
        civilDate(value) === today
          ? `${t("Hoy", "Hoxe")}, ${calendarLabel(value, locale, "short")}`
          : calendarLabel(value, locale, "day")
      }
      onChange={(value) => onChange(civilDate(value))}
    />
  );
}

export function DurationField({
  value,
  options,
  range,
  onChange,
}: {
  value: number | undefined;
  options: number[];
  /** Ranges too large to enumerate are entered as minutes within these limits. */
  range?: { minimum: number; maximum?: number; step: number };
  onChange: (minutes: number) => void;
}) {
  const { t } = usePreferences();
  if (range)
    return (
      <Input
        label={t("Duración en minutos", "Duración en minutos")}
        type="number"
        inputMode="numeric"
        min={range.minimum}
        max={range.maximum}
        step={range.step}
        value={value ?? ""}
        description={
          range.maximum === undefined
            ? undefined
            : t(
                `De ${durationLabel(range.minimum)} a ${durationLabel(range.maximum)}, en intervalos de ${range.step} min`,
                `De ${durationLabel(range.minimum)} a ${durationLabel(range.maximum)}, en intervalos de ${range.step} min`,
              )
        }
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    );
  return (
    <Select
      label={t("Duración", "Duración")}
      value={value === undefined ? "" : String(value)}
      placeholder={t("Elegir", "Escoller")}
      onValueChange={(next) => onChange(Number(next))}
      options={options.map((minutes) => ({
        value: String(minutes),
        label: durationLabel(minutes),
      }))}
    />
  );
}

export function SlotList({
  slots,
  timeZone,
  href,
  limit,
  more,
}: {
  slots: Slot[];
  timeZone: string;
  href: (slot: Slot) => string;
  limit?: number;
  more?: ReactNode;
}) {
  const { locale, t } = usePreferences();
  const shown = limit === undefined ? slots : slots.slice(0, limit);
  return (
    <>
      <ul className={styles.slots}>
        {shown.map((slot) => {
          const next = endsNextDay(slot.start.utc, slot.end.utc, timeZone);
          const label = timeRange(
            slot.start.utc,
            slot.end.utc,
            timeZone,
            locale,
          );
          return (
            <li key={slot.start.utc}>
              <Link
                className={styles.slot}
                to={href(slot)}
                data-offset={
                  repeatedTime(slot.start.utc, timeZone) ||
                  repeatedTime(slot.end.utc, timeZone) ||
                  undefined
                }
                aria-label={
                  next
                    ? `${label}, ${t("termina al día siguiente", "remata ao día seguinte")}`
                    : label
                }
              >
                {label}
                {next && (
                  <span className={styles.nextDay} aria-hidden="true">
                    +1
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {limit !== undefined && slots.length > limit && more}
    </>
  );
}

export function MoreLink({ to, children }: { to: string; children: string }) {
  return (
    <Link className={styles.more} to={to}>
      {children}
    </Link>
  );
}

/** One summary for review and detail: where, which space, when. */
export function BookingSummary({
  context,
  unitName,
  startsAt,
  endsAt,
  timeZone,
  children,
}: {
  context: string;
  unitName: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  children?: ReactNode;
}) {
  const { locale, t } = usePreferences();
  const day = calendarLabel(
    calendarDate(municipalToday(timeZone, new Date(startsAt))),
    locale,
    "full",
  );
  const minutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60000;
  return (
    <aside
      className={styles.summary}
      aria-label={t("Resumen de la reserva", "Resumo da reserva")}
    >
      <p className={styles.summaryContext}>{context}</p>
      <h2 className={styles.summaryTitle}>{unitName}</h2>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <CalendarDays size={16} aria-hidden="true" />
          <dt>{t("Fecha", "Data")}</dt>
          <dd>{day}</dd>
        </div>
        <div className={styles.fact}>
          <Clock3 size={16} aria-hidden="true" />
          <dt>{t("Horario", "Horario")}</dt>
          <dd>
            {timeRange(startsAt, endsAt, timeZone, locale)}
            <small>
              {durationLabel(minutes)}
              {endsNextDay(startsAt, endsAt, timeZone) &&
                ` · ${t("termina al día siguiente", "remata ao día seguinte")}`}
            </small>
          </dd>
        </div>
      </dl>
      {children}
    </aside>
  );
}

export function RulesText({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
    <section className={styles.rules} aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
