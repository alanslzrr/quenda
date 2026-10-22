import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { type Appearance, api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import layout from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Calendar } from "../../ui/calendar/calendar";
import { Input } from "../../ui/input/input";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import { calendarDate, civilDate, municipalToday, slotLabel } from "./dates";
import styles from "./unit.module.css";

interface Unit {
  id: string;
  name: string;
  timeZone: string;
  municipalAdvanceDays: number;
  cancellationMinutes: number;
  bookingPolicyVersion: number;
  usageRulesVersion: number;
  calendarVersion: number;
  calendar: {
    minimumMinutes: number;
    maximumMinutes: number;
    stepMinutes: number;
    advanceDays: number | null;
  };
}
interface Instant {
  utc: string;
  local: string;
  offset: string;
  timeZone: string;
}
interface Availability {
  unitId: string;
  date: string;
  timeZone: string;
  calculatedAt: string;
  slots: { start: Instant; end: Instant; durationMinutes: number }[];
}
export function UnitPage() {
  const { tenantId, unitId } = useParams();
  const { locale } = usePreferences();
  const unit = useQuery({
    queryKey: ["public", tenantId, unitId, "calendar", locale],
    queryFn: ({ signal }) =>
      api<Unit>(
        `/api/public/municipalities/${tenantId}/units/${unitId}`,
        { signal },
        locale,
      ),
  });
  const appearance = useQuery({
    queryKey: ["public", tenantId, "appearance"],
    queryFn: ({ signal }) =>
      api<Appearance>(
        `/api/public/municipalities/${tenantId}/appearance`,
        { signal },
        locale,
      ),
  });
  useMunicipalTheme(appearance.data);
  if (unit.isPending) return <Loading />;
  if (unit.isError)
    return <Failure error={unit.error} retry={() => void unit.refetch()} />;
  return (
    <UnitAvailability
      key={`${tenantId}:${unitId}`}
      tenantId={tenantId ?? ""}
      unit={unit.data}
    />
  );
}
function UnitAvailability({
  tenantId,
  unit,
}: {
  tenantId: string;
  unit: Unit;
}) {
  const { locale, t } = usePreferences();
  const [date, setDate] = useState(() => municipalToday(unit.timeZone));
  const [duration, setDuration] = useState(unit.calendar.minimumMinutes);
  const today = calendarDate(municipalToday(unit.timeZone));
  const maximum = new Date(today);
  maximum.setDate(
    maximum.getDate() +
      (unit.calendar.advanceDays ?? unit.municipalAdvanceDays),
  );
  const valid =
    Number.isInteger(duration) &&
    duration >= unit.calendar.minimumMinutes &&
    duration <= unit.calendar.maximumMinutes &&
    duration % unit.calendar.stepMinutes === 0;
  const availability = useQuery({
    queryKey: [
      "public",
      tenantId,
      unit.id,
      "availability",
      date,
      duration,
      locale,
    ],
    enabled: valid,
    queryFn: ({ signal }) =>
      api<Availability>(
        `/api/public/municipalities/${tenantId}/units/${unit.id}/availability?date=${date}&durationMinutes=${duration}`,
        { signal },
        locale,
      ),
  });
  return (
    <>
      <Link to={`/municipios/${tenantId}`}>
        {t("Instalaciones del municipio", "Instalacións do municipio")}
      </Link>
      <div className={layout.hero}>
        <p className={layout.eyebrow} style={{ marginTop: "2rem" }}>
          {t("Disponibilidad", "Dispoñibilidade")}
        </p>
        <h1 className={layout.title}>{unit.name}</h1>
        <p className={layout.description}>
          {t(
            "Horarios en la zona del municipio:",
            "Horarios na zona do municipio:",
          )}{" "}
          {unit.timeZone}.{" "}
          {t(
            "Consultar una franja no la reserva.",
            "Consultar unha franxa non a reserva.",
          )}
        </p>
      </div>
      <div className={styles.grid}>
        <section
          aria-label={t("Fecha y duración", "Data e duración")}
          className={styles.controls}
        >
          <Calendar
            today={today}
            locale={locale}
            value={calendarDate(date)}
            onChange={(value) => setDate(civilDate(value))}
            minDate={today}
            maxDate={maximum}
          />
          <Input
            label={t("Duración en minutos", "Duración en minutos")}
            type="number"
            value={Number.isFinite(duration) ? duration : ""}
            min={unit.calendar.minimumMinutes}
            max={unit.calendar.maximumMinutes}
            step={unit.calendar.stepMinutes}
            onChange={(event) => setDuration(event.target.valueAsNumber)}
            error={
              valid
                ? undefined
                : t(
                    "Introduce una duración permitida.",
                    "Introduce unha duración permitida.",
                  )
            }
          />
        </section>
        <section aria-labelledby="slots-heading">
          <h2 id="slots-heading" className={layout.sectionTitle}>
            {calendarLabel(calendarDate(date), locale, "long")}
          </h2>
          {!valid ? null : availability.isPending ? (
            <Loading />
          ) : availability.isError ? (
            <Failure
              error={availability.error}
              retry={() => void availability.refetch()}
            />
          ) : (
            <>
              <ul className={styles.slots}>
                {availability.data.slots.map((slot) => (
                  <li key={slot.start.utc}>
                    <span className={styles.slot}>
                      {slotLabel(slot.start.utc, unit.timeZone, locale)} —{" "}
                      {slotLabel(slot.end.utc, unit.timeZone, locale)}
                      <small>UTC{slot.start.offset}</small>
                    </span>
                  </li>
                ))}
              </ul>
              {availability.data.slots.length === 0 && (
                <p className={layout.empty}>
                  {t(
                    "No hay franjas disponibles para esta fecha y duración.",
                    "Non hai franxas dispoñibles para esta data e duración.",
                  )}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
