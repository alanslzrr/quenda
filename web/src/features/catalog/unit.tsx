import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ApiError, api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Alert } from "../../ui/alert/alert";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import {
  bookingQuery,
  DateField,
  DurationField,
  type Slot,
  SlotList,
  useBookingParams,
} from "./booking";
import styles from "./booking.module.css";
import {
  calendarDate,
  civilDate,
  durationLabel,
  durationOptions,
} from "./dates";
import { FacilityDetails } from "./facility-details";
import {
  BookingSteps,
  facilityPath,
  JourneyLoading,
  municipalityPath,
  useJourneyQuery,
} from "./journey";
import { useMunicipality, usePublicAppearance } from "./municipality";
import { PhotoGallery } from "./photo-gallery";
import { type CatalogPhoto, publicPhotos } from "./photos";
import {
  type FacilityProfile,
  localized,
  type UnitProfile,
  unitFacts,
} from "./profile";

export interface Unit {
  id: string;
  name: string;
  facilityId: string;
  facilityName: string;
  timeZone: string;
  municipalAdvanceDays: number;
  cancellationMinutes: number;
  bookingPolicyVersion: number;
  usageRulesVersion: number;
  calendarVersion: number;
  profile?: UnitProfile;
  facilityProfile?: FacilityProfile;
  photos?: CatalogPhoto[];
  facilityPhotos?: CatalogPhoto[];
  calendar: {
    minimumMinutes: number;
    maximumMinutes: number;
    stepMinutes: number;
    advanceDays: number | null;
  };
}
export interface Availability {
  unitId: string;
  date: string;
  timeZone: string;
  calculatedAt: string;
  slots: (Slot & { durationMinutes: number })[];
}

export function usePublicUnit(tenantId: string, unitId: string | undefined) {
  const { locale } = usePreferences();
  return useQuery({
    queryKey: ["public", tenantId, unitId, "calendar", locale],
    enabled: !!unitId,
    queryFn: ({ signal }) =>
      api<Unit>(
        `/api/public/municipalities/${tenantId}/units/${unitId}`,
        { signal },
        locale,
      ),
  });
}

/** A space the municipality withdrew or changed cannot be booked; offer the step that still works. */
export function UnitUnavailable({ to, label }: { to: string; label?: string }) {
  const { t } = usePreferences();
  return (
    <div className={styles.page}>
      <div className={styles.empty}>
        <p>
          {t(
            "Este espacio no está disponible para reservar.",
            "Este espazo non está dispoñible para reservar.",
          )}
        </p>
        <span>
          {t(
            "Puede que el ayuntamiento lo haya retirado o cambiado. Elige otro espacio.",
            "Pode que o concello o retirase ou cambiase. Escolle outro espazo.",
          )}
        </span>
      </div>
      <LinkButton to={to} variant="primary">
        {label ?? t("Ver instalaciones", "Ver instalacións")}
      </LinkButton>
    </div>
  );
}

/** Fourth step: day, duration and time for one unit. */
export function UnitPage() {
  const { tenantId = "", unitId } = useParams();
  const query = useJourneyQuery();
  const unit = usePublicUnit(tenantId, unitId);
  const municipality = useMunicipality(tenantId);
  usePublicAppearance(tenantId);
  if (unit.isPending) return <JourneyLoading />;
  if (unit.isError)
    return unit.error instanceof ApiError && unit.error.status === 404 ? (
      <UnitUnavailable to={municipalityPath(tenantId, query)} />
    ) : (
      <Failure error={unit.error} retry={() => void unit.refetch()} />
    );
  return (
    <UnitAvailability
      key={`${tenantId}:${unitId}`}
      tenantId={tenantId}
      unit={unit.data}
      municipality={municipality.data?.name}
    />
  );
}

function addDays(date: string, days: number) {
  const value = calendarDate(date);
  value.setDate(value.getDate() + days);
  return civilDate(value);
}

export function UnitAvailability({
  tenantId,
  unit,
  reservationId,
  owner,
  municipality,
}: {
  tenantId: string;
  unit: Unit;
  reservationId?: string;
  owner?: string;
  municipality?: string;
}) {
  const { locale, t } = usePreferences();
  const { account } = useSession();
  const params = useBookingParams(unit.timeZone);
  const { minimumMinutes, maximumMinutes, stepMinutes } = unit.calendar;
  const admits = (minutes: number | undefined): minutes is number =>
    minutes !== undefined &&
    Number.isInteger(minutes) &&
    minutes >= minimumMinutes &&
    minutes <= maximumMinutes &&
    minutes % stepMinutes === 0;
  const options = durationOptions(unit.calendar);
  const enumerable = (maximumMinutes - minimumMinutes) / stepMinutes < 48;
  // A duration or day chosen for another space may not fit this one: replace only that value and say so.
  const durationReplaced =
    enumerable && params.duration !== undefined && !admits(params.duration);
  const duration =
    admits(params.duration) || (!enumerable && params.duration !== undefined)
      ? params.duration
      : (options[0] ?? minimumMinutes);
  const valid = admits(duration);
  const maxDays = unit.calendar.advanceDays ?? unit.municipalAdvanceDays;
  const lastDate = addDays(params.today, maxDays);
  const dateReplaced = params.date > lastDate;
  const date = dateReplaced ? params.today : params.date;
  const query = bookingQuery({ date, duration: valid ? duration : undefined });
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
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = calendarLabel(calendarDate(date), locale, "day");
  const headingId = `slots-${unit.id}`;
  const facility = { id: unit.facilityId, name: unit.facilityName };
  return (
    <div className={styles.page}>
      {!reservationId && (
        <>
          <BookingSteps
            current={3}
            tenantId={tenantId}
            municipality={municipality}
            facility={facility}
            unit={unit}
            query={query}
          />
          <header className={styles.intro}>
            <p className={styles.context}>
              {[municipality, unit.facilityName].filter(Boolean).join(" · ")}
            </p>
            <h1 className={styles.title}>{unit.name}</h1>
            {unitFacts(unit.profile, locale).length > 0 && (
              <p className={styles.context}>
                {unitFacts(unit.profile, locale).join(" · ")}
              </p>
            )}
            {/* Without photos of its own, a space shows those of its facility. */}
            <PhotoGallery
              photos={
                unit.photos?.length ? unit.photos : (unit.facilityPhotos ?? [])
              }
              source={publicPhotos(tenantId)}
              label={unit.photos?.length ? unit.name : `${unit.facilityName}`}
            />
            {localized(unit.profile?.description, locale) && (
              <p className={styles.lead}>
                {localized(unit.profile?.description, locale)}
              </p>
            )}
            <FacilityDetails profile={unit.facilityProfile} />
            <p className={styles.lead}>
              {t(
                "Elige el día, la duración y una hora libre.",
                "Escolle o día, a duración e unha hora libre.",
              )}
            </p>
            <div className={styles.introActions}>
              <Link
                className={styles.textLink}
                to={facilityPath(tenantId, unit.facilityId, query)}
              >
                {t("Cambiar espacio", "Cambiar espazo")}
              </Link>
            </div>
          </header>
        </>
      )}
      {(durationReplaced || dateReplaced || params.dateAdjusted) && (
        <Alert
          className={styles.adjusted}
          tone="info"
          title={t(
            "Hemos ajustado tu selección a este espacio",
            "Axustamos a túa selección a este espazo",
          )}
        >
          {[
            params.dateAdjusted &&
              t(
                "El día elegido no es válido o ya ha pasado; mostramos hoy.",
                "O día elixido non é válido ou xa pasou; amosamos hoxe.",
              ),
            durationReplaced &&
              t(
                `No admite reservas de ${durationLabel(params.duration ?? 0)}; mostramos ${durationLabel(duration ?? minimumMinutes)}.`,
                `Non admite reservas de ${durationLabel(params.duration ?? 0)}; amosamos ${durationLabel(duration ?? minimumMinutes)}.`,
              ),
            dateReplaced &&
              t(
                `Solo se puede reservar con ${maxDays} días de antelación; mostramos hoy.`,
                `Só se pode reservar con ${maxDays} días de antelación; amosamos hoxe.`,
              ),
          ]
            .filter(Boolean)
            .join(" ")}
        </Alert>
      )}
      <div className={styles.search} data-fields={2}>
        <DateField
          date={date}
          today={params.today}
          maxDays={maxDays}
          onChange={(next) => params.update({ fecha: next })}
        />
        <DurationField
          value={duration}
          options={options}
          range={
            enumerable
              ? undefined
              : {
                  minimum: minimumMinutes,
                  maximum: maximumMinutes,
                  step: stepMinutes,
                }
          }
          onChange={(minutes) =>
            params.update({
              duracion: Number.isInteger(minutes) ? String(minutes) : "",
            })
          }
        />
      </div>
      <section className={styles.slotsSection} aria-labelledby={headingId}>
        <div className={styles.resultsHead}>
          <h2 id={headingId}>{t("Horarios libres", "Horarios libres")}</h2>
          {valid && (
            <p>
              {day} · {durationLabel(duration)}
            </p>
          )}
        </div>
        {browserZone !== unit.timeZone && (
          <p className={styles.timeZone}>
            {t(
              `Horas locales del municipio (${unit.timeZone}).`,
              `Horas locais do municipio (${unit.timeZone}).`,
            )}
          </p>
        )}
        {!valid ? (
          <div className={styles.empty}>
            <p>
              {t(
                "Indica una duración admitida para ver los horarios.",
                "Indica unha duración admitida para ver os horarios.",
              )}
            </p>
          </div>
        ) : availability.isPending ? (
          <Loading />
        ) : availability.isError ? (
          <Failure
            error={availability.error}
            retry={() => void availability.refetch()}
          />
        ) : availability.data.slots.length === 0 ? (
          <div className={styles.empty}>
            <p>
              {t(
                `No quedan horarios libres de ${durationLabel(duration)} este día.`,
                `Non quedan horarios libres de ${durationLabel(duration)} este día.`,
              )}
            </p>
            <span>
              {t(
                "Prueba otro día u otra duración.",
                "Proba outro día ou outra duración.",
              )}
            </span>
            {!reservationId && duration && (
              <NextSlots
                tenantId={tenantId}
                unit={unit}
                from={date}
                duration={duration}
              />
            )}
          </div>
        ) : (
          <SlotList
            slots={availability.data.slots}
            timeZone={unit.timeZone}
            href={(slot) =>
              reservationId
                ? `/reservas/${tenantId}/${reservationId}/confirmar?unidad=${unit.id}&inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`
                : `/municipios/${tenantId}/unidades/${unit.id}/reservar?inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`
            }
          />
        )}
        {!reservationId && !account && (
          <p className={styles.quiet}>
            {t(
              "Al elegir una hora te pediremos que accedas o crees una cuenta. Después volverás a esta reserva.",
              "Ao escoller unha hora pedirémosche que accedas ou crees unha conta. Despois volverás a esta reserva.",
            )}
          </p>
        )}
      </section>
    </div>
  );
}

/** When the chosen day is full, the first free slots of the same duration on later days. */
function NextSlots({
  tenantId,
  unit,
  from,
  duration,
}: {
  tenantId: string;
  unit: Unit;
  from: string;
  duration: number;
}) {
  const { locale, t } = usePreferences();
  const suggestions = useQuery({
    queryKey: ["public", tenantId, unit.id, "next", from, duration, locale],
    queryFn: ({ signal }) =>
      api<{ slots: Slot[] }>(
        `/api/public/municipalities/${tenantId}/units/${unit.id}/next-availability?from=${from}&durationMinutes=${duration}`,
        { signal },
        locale,
      ),
    retry: false,
  });
  if (suggestions.isPending || suggestions.isError) return null;
  return (
    <div className={styles.suggestions}>
      <h3>{t("Próximos horarios libres", "Próximos horarios libres")}</h3>
      {suggestions.data.slots.length ? (
        <ul>
          {suggestions.data.slots.map((slot) => (
            <li key={slot.start.utc}>
              <Link
                to={`/municipios/${tenantId}/unidades/${unit.id}/reservar?inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`}
              >
                {`${calendarLabel(calendarDate(slot.start.local.slice(0, 10)), locale, "short")} · ${slot.start.local.slice(11, 16)}`}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          {t(
            "No hay huecos de esta duración en las próximas semanas.",
            "Non hai ocos desta duración nas próximas semanas.",
          )}
        </p>
      )}
    </div>
  );
}
