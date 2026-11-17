import { X } from "lucide-react";
import { useState } from "react";
import { DatePicker } from "../ui/date-picker/date-picker";
import picker from "../ui/date-picker/date-picker.module.css";
import { Input } from "../ui/input/input";
import { useMirrorInvalid } from "../ui/lib/mirror-invalid";
import { MonthPicker } from "../ui/month-picker/month-picker";
import styles from "./date-fields.module.css";
import { usePreferences } from "./preferences-provider";

/** `YYYY-MM-DD` read as a civil date at local midnight, so the calendar shows the same day in any zone. */
const civil = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : undefined;
};
const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

type Field = {
  label: string;
  /** The form field that carries the value, in the native input's format. */
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  required?: boolean;
  description?: string;
  error?: string;
};

/**
 * The form's value travels in a hidden mirror after the visible trigger. The mirror is never shown or focused: a failed
 * required check flags the trigger (see trackValidity), and the field writes its error below.
 */
function Mirror({
  name,
  value,
  required,
}: {
  name?: string;
  value: string;
  required: boolean;
}) {
  return (
    <input
      aria-hidden="true"
      tabIndex={-1}
      className={picker.mirror}
      name={name}
      value={value}
      required={required}
      onChange={() => {}}
    />
  );
}
function Clear({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      className={picker.clear}
      aria-label={label}
      onClick={onClear}
    >
      <X size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
function useValue({ value, defaultValue = "", onValueChange }: Field) {
  const [own, setOwn] = useState(defaultValue);
  return [
    value ?? own,
    (next: string) => {
      setOwn(next);
      onValueChange?.(next);
    },
  ] as const;
}

/** A civil date (`YYYY-MM-DD`) chosen on the application calendar. An optional one can be cleared. */
export function DateField(
  props: Field & {
    /** Earliest and latest selectable dates, as `YYYY-MM-DD`. */
    min?: string;
    max?: string;
  },
) {
  const { label, name, required = false, description, error, min, max } = props;
  const { t, locale } = usePreferences();
  const [current, set] = useValue(props);
  const mirror = useMirrorInvalid("date");
  return (
    <div ref={mirror.ref} className={styles.field}>
      <DatePicker
        label={label}
        locale={locale}
        value={civil(current)}
        minDate={min ? civil(min) : undefined}
        maxDate={max ? civil(max) : undefined}
        description={description}
        error={error ?? mirror.message}
        placeholder={t("Elige una fecha", "Escolle unha data")}
        onChange={(date) => {
          mirror.clear();
          set(iso(date));
        }}
      >
        <Mirror name={name} value={current} required={required} />
        {!required && current && (
          <Clear
            label={`${t("Borrar", "Borrar")}: ${label}`}
            onClear={() => set("")}
          />
        )}
      </DatePicker>
    </div>
  );
}

const timePattern = String.raw`([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?`;
const split = (value: string) => {
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};
const complete = (date: string, time: string) =>
  civil(date) && new RegExp(`^${timePattern}$`).test(time)
    ? `${date}T${time.indexOf(":") === 1 ? `0${time}` : time}`
    : "";

/**
 * A civil date and time (`YYYY-MM-DDTHH:mm`, seconds kept when given) as a calendar and a typed 24-hour time, the same
 * `hh:mm` the schedules use. The value is reported only once both parts are complete.
 */
export function DateTimeField(
  props: Field & {
    /** Called when the time is left, the moment a typed value is complete. */
    onBlur?: () => void;
  },
) {
  const { label, name, required = false, description, error, onBlur } = props;
  const { t } = usePreferences();
  const [current, set] = useValue(props);
  const [parts, setParts] = useState(() => split(current));
  // A value replaced from outside (a reset) restarts both parts.
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    if (current !== complete(parts.date, parts.time)) setParts(split(current));
  }
  const update = (next: { date: string; time: string }) => {
    setParts(next);
    const value = complete(next.date, next.time);
    setSeen(value);
    set(value);
  };
  return (
    <div className={styles.dateTime}>
      <DateField
        label={label}
        value={parts.date}
        required={required}
        description={description}
        error={error}
        onValueChange={(date) => update({ ...parts, date })}
      />
      <Input
        label={t("Hora", "Hora")}
        aria-label={`${label} · ${t("hora", "hora")}`}
        inputMode="numeric"
        autoComplete="off"
        placeholder="hh:mm"
        pattern={timePattern}
        title={t(
          "Hora en formato de 24 horas, hh:mm.",
          "Hora en formato de 24 horas, hh:mm.",
        )}
        required={required || !!parts.date}
        value={parts.time}
        onBlur={onBlur}
        onChange={(event) => update({ ...parts, time: event.target.value })}
      />
      {name && <input type="hidden" name={name} value={current} />}
    </div>
  );
}

/** A month (`YYYY-MM`) chosen from a year of months. */
export function MonthField(
  props: Field & {
    min?: string;
    max?: string;
  },
) {
  const { label, name, required = false, description, error, min, max } = props;
  const { t, locale } = usePreferences();
  const [current, set] = useValue(props);
  const mirror = useMirrorInvalid("month");
  return (
    <div ref={mirror.ref} className={styles.field}>
      <MonthPicker
        label={label}
        locale={locale}
        value={current}
        min={min}
        max={max}
        description={description}
        error={error ?? mirror.message}
        placeholder={t("Elige un mes", "Escolle un mes")}
        labels={{
          previousYear: t("Año anterior", "Ano anterior"),
          nextYear: t("Año siguiente", "Ano seguinte"),
        }}
        onChange={(month) => {
          mirror.clear();
          set(month);
        }}
      >
        <Mirror name={name} value={current} required={required} />
      </MonthPicker>
    </div>
  );
}
