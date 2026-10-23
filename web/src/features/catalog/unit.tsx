import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CalendarDays, Clock3, Info } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { type Appearance, api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import layout from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useMunicipalTheme } from "../../app/theme-provider";
import { BookingFrame } from "../../ui/blocks/multi-step-form/booking-frame";
import { Calendar } from "../../ui/calendar/calendar";
import { Input } from "../../ui/input/input";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import { calendarDate, civilDate, municipalToday, slotLabel } from "./dates";
import styles from "./unit.module.css";

export interface Unit {
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
export interface Availability {
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
export function UnitAvailability({
  tenantId,
  unit,
  reservationId,
  owner,
}: {
  tenantId: string;
  unit: Unit;
  reservationId?: string;
  owner?: string;
}) {
  const { locale, t } = usePreferences();
  const [date, setDate] = useState(() => municipalToday(unit.timeZone));
  const [duration, setDuration] = useState(unit.calendar.minimumMinutes);
  const Heading = reservationId ? "h2" : "h1";
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
      ...(reservationId ? ["private", owner] : ["public"]),
      reservationId,
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
        reservationId
          ? `/api/municipalities/${tenantId}/reservations/${reservationId}/availability?unitId=${unit.id}&date=${date}&durationMinutes=${duration}`
          : `/api/public/municipalities/${tenantId}/units/${unit.id}/availability?date=${date}&durationMinutes=${duration}`,
        { signal },
        locale,
      ),
  });
  return (
    <div className={styles.page}>
      <Link className={styles.back} to={`/municipios/${tenantId}`}>
        {t("Instalaciones del municipio", "Instalacións do municipio")}
      </Link>
      <header className={styles.header}>
        <div className={styles.unitIcon}>
          <CalendarDays size={22} strokeWidth={1.5} aria-hidden="true" />
        </div>
        <div>
          <p className={styles.eyebrow}>
            {t("Unidad reservable", "Unidade reservable")}
          </p>
          <Heading>{unit.name}</Heading>
          <p className={styles.zone}>{unit.timeZone}</p>
        </div>
      </header>
      <BookingFrame
        index={0}
        labels={[
          t("Fecha y hora", "Data e hora"),
          t("Revisar y confirmar", "Revisar e confirmar"),
        ]}
        progressLabel={t("Pasos de la reserva", "Pasos da reserva")}
      >
        <div className={styles.grid}>
          <section
            aria-label={t("Fecha y duración", "Data e duración")}
            className={styles.controls}
          >
            <div className={styles.controlHeading}>
              <CalendarDays size={16} aria-hidden="true" />
              <h2>{t("Elige una fecha", "Escolle unha data")}</h2>
            </div>
            <Calendar
              today={today}
              locale={locale}
              value={calendarDate(date)}
              onChange={(value) => setDate(civilDate(value))}
              minDate={today}
              maxDate={maximum}
            />
            <div className={styles.duration}>
              <Clock3 size={16} aria-hidden="true" />
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
            </div>
            <p className={styles.note}>
              {t(
                "Consultar una franja no la reserva.",
                "Consultar unha franxa non a reserva.",
              )}
            </p>
          </section>
          <section
            className={styles.availability}
            aria-labelledby="slots-heading"
          >
            <h2 id="slots-heading" className={layout.sectionTitle}>
              {calendarLabel(calendarDate(date), locale, "long")}
            </h2>
            <p className={styles.zone}>
              {t(
                "Selecciona una hora de inicio.",
                "Selecciona unha hora de inicio.",
              )}{" "}
              {duration > 0 && `${duration} min`}
            </p>
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
                      <Link
                        className={styles.slot}
                        to={
                          reservationId
                            ? `/reservas/${tenantId}/${reservationId}/confirmar?unidad=${unit.id}&inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`
                            : `/municipios/${tenantId}/unidades/${unit.id}/reservar?inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`
                        }
                      >
                        <span>
                          {slotLabel(slot.start.utc, unit.timeZone, locale)}{" "}
                          <span aria-hidden="true">–</span>{" "}
                          {slotLabel(slot.end.utc, unit.timeZone, locale)}
                        </span>
                        <small>
                          UTC{slot.start.offset}
                          <ArrowRight size={14} aria-hidden="true" />
                        </small>
                      </Link>
                    </li>
                  ))}
                </ul>
                {availability.data.slots.length === 0 && (
                  <div className={styles.empty}>
                    <CalendarDays
                      size={30}
                      strokeWidth={1.25}
                      aria-hidden="true"
                    />
                    <p>
                      {t(
                        "No hay franjas disponibles para esta fecha y duración.",
                        "Non hai franxas dispoñibles para esta data e duración.",
                      )}
                    </p>
                    <span>
                      {t(
                        "Prueba otra fecha o duración.",
                        "Proba outra data ou duración.",
                      )}
                    </span>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
        <p className={styles.footnote}>
          <Info size={15} aria-hidden="true" />
          {t(
            "La disponibilidad se comprueba de nuevo al confirmar.",
            "A dispoñibilidade compróbase de novo ao confirmar.",
          )}
        </p>
      </BookingFrame>
    </div>
  );
}
