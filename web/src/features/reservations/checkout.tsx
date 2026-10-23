import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  Clock3,
  MapPin,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError, type Appearance, api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useMunicipalTheme } from "../../app/theme-provider";
import { BookingFrame } from "../../ui/blocks/multi-step-form/booking-frame";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { slotLabel } from "../catalog/dates";
import type { Unit } from "../catalog/unit";
import booking from "../catalog/unit.module.css";
import type { CommandPolicy } from "./commands";
import {
  dateTime,
  ReservationAction,
  reservationPath,
  useReservation,
} from "./shared";
export function Checkout() {
  const { tenantId = "", unitId: routeUnit, reservationId = "" } = useParams();
  const [search] = useSearchParams();
  const unitId = routeUnit ?? search.get("unidad") ?? "";
  const startsAt = search.get("inicio") ?? "";
  const endsAt = search.get("fin") ?? "";
  const { locale, t } = usePreferences();
  const [failure, setFailure] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const original = useReservation(tenantId, reservationId);
  const unit = useQuery({
    queryKey: ["public", tenantId, unitId, "checkout", locale],
    queryFn: ({ signal }) =>
      api<Unit>(
        `/api/public/municipalities/${tenantId}/units/${unitId}`,
        { signal },
        locale,
      ),
    staleTime: 0,
  });
  const rules = useQuery({
    queryKey: ["public", tenantId, unitId, "rules", locale],
    queryFn: ({ signal }) =>
      api<{ version: number; text: string }>(
        `/api/public/municipalities/${tenantId}/units/${unitId}/usage-rules`,
        { signal },
        locale,
      ),
    staleTime: 0,
  });
  const policy = useQuery({
    queryKey: ["public", "command-policy"],
    queryFn: ({ signal }) =>
      api<CommandPolicy>(
        "/api/public/reservation-command-policy",
        { signal },
        locale,
      ),
    staleTime: 0,
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
  if (
    unit.isPending ||
    rules.isPending ||
    policy.isPending ||
    (reservationId && original.isPending)
  )
    return <Loading />;
  const refresh = async () => {
    setGeneration((n) => n + 1);
    await Promise.all([
      unit.refetch(),
      rules.refetch(),
      policy.refetch(),
      ...(reservationId ? [original.refetch()] : []),
    ]);
  };
  if (unit.isError || rules.isError || policy.isError || original.isError)
    return (
      <Failure
        error={unit.error ?? rules.error ?? policy.error ?? original.error}
        retry={() => void refresh()}
      />
    );
  const now =
    Date.parse(policy.data.serverTime) +
    Math.max(0, Date.now() - policy.dataUpdatedAt);
  if (
    !Number.isFinite(Date.parse(startsAt)) ||
    !Number.isFinite(Date.parse(endsAt)) ||
    Date.parse(endsAt) <= Date.parse(startsAt)
  )
    return (
      <p>
        {t(
          "Selecciona una franja válida en el calendario.",
          "Selecciona unha franxa válida no calendario.",
        )}
      </p>
    );
  const nonCancellable =
    now > Date.parse(startsAt) - unit.data.cancellationMinutes * 60000;
  const deadline = new Date(
    Date.parse(startsAt) - unit.data.cancellationMinutes * 60000,
  ).toISOString();
  const base = `/api/municipalities/${tenantId}/reservations`;
  const body = {
    ...(reservationId ? { expectedRevision: original.data?.revision } : {}),
    unitId,
    startsAt,
    endsAt,
    acceptance: {
      usageRulesVersion: rules.data.version,
      bookingPolicyVersion: unit.data.bookingPolicyVersion,
      nonCancellable,
    },
  };
  return (
    <div className={booking.page}>
      <Link
        className={booking.back}
        to={
          reservationId
            ? `/reservas/${tenantId}/${reservationId}/modificar`
            : `/municipios/${tenantId}/unidades/${unitId}`
        }
      >
        {t("Elegir otra franja", "Escoller outra franxa")}
      </Link>
      <header className={booking.header}>
        <div className={booking.unitIcon}>
          <ShieldCheck size={22} strokeWidth={1.5} aria-hidden="true" />
        </div>
        <div>
          <p className={booking.eyebrow}>{unit.data.name}</p>
          <h1>
            {t(
              reservationId ? "Confirmar modificación" : "Confirmar reserva",
              reservationId ? "Confirmar modificación" : "Confirmar reserva",
            )}
          </h1>
        </div>
      </header>
      <BookingFrame
        index={1}
        labels={[
          t("Fecha y hora", "Data e hora"),
          t("Revisar y confirmar", "Revisar e confirmar"),
        ]}
        progressLabel={t("Pasos de la reserva", "Pasos da reserva")}
      >
        <div className={booking.checkout}>
          <aside
            className={booking.summary}
            aria-label={t("Resumen de la reserva", "Resumo da reserva")}
          >
            <h2>{unit.data.name}</h2>
            <dl>
              <div>
                <dt>
                  <CalendarDays size={16} aria-hidden="true" />
                  {t("Fecha", "Data")}
                </dt>
                <dd>
                  {new Intl.DateTimeFormat(locale, {
                    timeZone: unit.data.timeZone,
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  }).format(new Date(startsAt))}
                </dd>
              </div>
              <div>
                <dt>
                  <Clock3 size={16} aria-hidden="true" />
                  {t("Horario", "Horario")}
                </dt>
                <dd>
                  {slotLabel(startsAt, unit.data.timeZone, locale)} –{" "}
                  {slotLabel(endsAt, unit.data.timeZone, locale)}
                  <small>
                    {(Date.parse(endsAt) - Date.parse(startsAt)) / 60000} min
                  </small>
                </dd>
              </div>
              <div>
                <dt>
                  <MapPin size={16} aria-hidden="true" />
                  {t("Zona horaria", "Zona horaria")}
                </dt>
                <dd>
                  {unit.data.timeZone}
                  <small>
                    {dateTime(startsAt, unit.data.timeZone, locale)}
                    <br />
                    {dateTime(endsAt, unit.data.timeZone, locale)}
                  </small>
                </dd>
              </div>
            </dl>
          </aside>
          <section className={booking.review}>
            {failure !== undefined && <Failure error={failure} />}
            <div
              className={nonCancellable ? booking.warning : booking.conditions}
            >
              <h2>
                {nonCancellable && (
                  <TriangleAlert size={17} aria-hidden="true" />
                )}
                {nonCancellable
                  ? t("Sin cancelación ordinaria", "Sen cancelación ordinaria")
                  : t(
                      "Condiciones de cancelación",
                      "Condicións de cancelación",
                    )}
              </h2>
              <p>
                {t(
                  "Cancelación ordinaria hasta:",
                  "Cancelación ordinaria ata:",
                )}{" "}
                {dateTime(deadline, unit.data.timeZone, locale)}.
              </p>
              <p>
                {t(
                  "Dentro del plazo restringido no puedes cancelar ni modificar para eludirlo. El municipio puede valorar una cancelación excepcional. No se generan penalizaciones automáticas.",
                  "Dentro do prazo restrinxido non podes cancelar nin modificar para evitalo. O municipio pode valorar unha cancelación excepcional. Non se xeran penalizacións automáticas.",
                )}
              </p>
              <p>
                {t(
                  "La titularidad y la responsabilidad no se transfieren. Cambiar participantes solo está permitido cuando lo permitan las normas municipales.",
                  "A titularidade e a responsabilidade non se transfiren. Cambiar participantes só está permitido cando o permitan as normas municipais.",
                )}
              </p>
            </div>
            <div className={booking.rules}>
              <h2>
                {t("Normas de uso", "Normas de uso")} ·{" "}
                {t("versión", "versión")} {rules.data.version}
              </h2>
              <p style={{ whiteSpace: "pre-wrap" }}>{rules.data.text}</p>
            </div>
            {rules.data.version !== unit.data.usageRulesVersion ? (
              <Failure
                error={
                  new ApiError(
                    0,
                    "CONDITIONS_CHANGED",
                    t(
                      "Las condiciones han cambiado. Actualiza y revisa las normas.",
                      "As condicións cambiaron. Actualiza e revisa as normas.",
                    ),
                  )
                }
                retry={() => void refresh()}
              />
            ) : (
              <ReservationAction
                key={`${unitId}:${startsAt}:${endsAt}:${rules.data.version}:${unit.data.bookingPolicyVersion}:${nonCancellable}:${original.data?.revision}:${generation}`}
                path={
                  reservationId
                    ? `${reservationPath(tenantId, reservationId)}/modify`
                    : base
                }
                body={body}
                label={t(
                  reservationId
                    ? "Confirmar modificación"
                    : "Confirmar reserva",
                  reservationId
                    ? "Confirmar modificación"
                    : "Confirmar reserva",
                )}
                onFailure={async (error) => {
                  if (
                    error instanceof ApiError &&
                    ["CONDITIONS_CHANGED", "CONFLICT"].includes(error.code)
                  ) {
                    setFailure(error);
                    await refresh();
                  } else setFailure(undefined);
                }}
              >
                <Checkbox
                  required
                  name="acceptance"
                  label={t(
                    "Acepto estas normas y las condiciones de cancelación.",
                    "Acepto estas normas e as condicións de cancelación.",
                  )}
                />
                {nonCancellable && (
                  <Checkbox
                    required
                    name="nonCancellable"
                    label={t(
                      "Acepto que esta reserva no permite cancelación ni modificación ordinaria por su proximidad al inicio.",
                      "Acepto que esta reserva non permite cancelación nin modificación ordinaria pola súa proximidade ao inicio.",
                    )}
                  />
                )}
              </ReservationAction>
            )}
          </section>
        </div>
      </BookingFrame>
    </div>
  );
}
