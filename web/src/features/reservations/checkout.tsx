import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError, api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { isUuid } from "../../app/ids.ts";
import { usePreferences } from "../../app/preferences-provider";
import { Alert } from "../../ui/alert/alert";
import { Checkbox } from "../../ui/checkbox/checkbox";
import {
  BackLink,
  BookingSummary,
  bookingQuery,
  RulesText,
} from "../catalog/booking";
import booking from "../catalog/booking.module.css";
import { durationLabel, intervalLabel, municipalToday } from "../catalog/dates";
import { BookingSteps, municipalityPath, unitPath } from "../catalog/journey";
import { useMunicipality, usePublicAppearance } from "../catalog/municipality";
import { UnitUnavailable, usePublicUnit } from "../catalog/unit";
import type { CommandPolicy } from "./commands";
import {
  dateTime,
  ReservationAction,
  reservationPath,
  useReservation,
} from "./shared";

function InvalidSlot({ back, label }: { back: string; label: string }) {
  const { t } = usePreferences();
  return (
    <div className={booking.page}>
      <BackLink to={back}>{label}</BackLink>
      <div className={booking.empty}>
        <p>
          {t(
            "Este horario no es válido. Elige otro en la lista de horarios libres.",
            "Este horario non é válido. Escolle outro na lista de horarios libres.",
          )}
        </p>
      </div>
    </div>
  );
}

export function Checkout() {
  const { tenantId = "", unitId: routeUnit, reservationId = "" } = useParams();
  const [search] = useSearchParams();
  const requestedUnit = routeUnit ?? search.get("unidad") ?? "";
  // The unit id is interpolated into API paths, so anything but a UUID is treated as missing.
  const unitId = isUuid(requestedUnit) ? requestedUnit : "";
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
  const municipality = useMunicipality(tenantId);
  usePublicAppearance(tenantId);
  const original = useReservation(tenantId, reservationId);
  const unit = usePublicUnit(tenantId, unitId);
  const rules = useQuery({
    queryKey: ["public", tenantId, unitId, "rules", locale],
    queryFn: ({ signal }) =>
      api<{ version: number; text: string }>(
        `/api/public/municipalities/${tenantId}/units/${unitId}/usage-rules`,
        { signal },
        locale,
      ),
    enabled: !!unitId,
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
  const changeBack = reservationId
    ? `/reservas/${tenantId}/${reservationId}/modificar`
    : municipalityPath(tenantId);
  if (!unitId)
    return (
      <InvalidSlot
        back={changeBack}
        label={
          reservationId
            ? t("Elegir horario", "Escoller horario")
            : t("Elegir espacio", "Escoller espazo")
        }
      />
    );
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
  const gone = [unit.error, rules.error].some(
    (error) => error instanceof ApiError && error.status === 404,
  );
  if (gone)
    return (
      <UnitUnavailable
        to={changeBack}
        label={
          reservationId
            ? t("Elegir otro espacio", "Escoller outro espazo")
            : undefined
        }
      />
    );
  if (unit.isError || rules.isError || policy.isError || original.isError)
    return (
      <Failure
        error={unit.error ?? rules.error ?? policy.error ?? original.error}
        retry={() => void refresh()}
      />
    );
  const minutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60000;
  const query = bookingQuery({
    date: Number.isFinite(Date.parse(startsAt))
      ? municipalToday(unit.data.timeZone, new Date(startsAt))
      : undefined,
    duration: minutes > 0 ? minutes : undefined,
  });
  // Going back from a change review keeps the chosen space, day and duration.
  const back = reservationId
    ? `/reservas/${tenantId}/${reservationId}/modificar${bookingQuery({
        date: Number.isFinite(Date.parse(startsAt))
          ? municipalToday(unit.data.timeZone, new Date(startsAt))
          : undefined,
        duration: minutes > 0 ? minutes : undefined,
        facility: unit.data.facilityId,
        unit: unitId,
      })}`
    : unitPath(tenantId, unitId, query);
  if (
    !Number.isFinite(Date.parse(startsAt)) ||
    !Number.isFinite(Date.parse(endsAt)) ||
    minutes <= 0
  )
    return (
      <InvalidSlot
        back={back}
        label={t("Elegir horario", "Escoller horario")}
      />
    );
  const now =
    Date.parse(policy.data.serverTime) +
    Math.max(0, Date.now() - policy.dataUpdatedAt);
  const window = unit.data.cancellationMinutes * 60000;
  const nonCancellable = now > Date.parse(startsAt) - window;
  const deadline = new Date(Date.parse(startsAt) - window).toISOString();
  const facility = unit.data.facilityName;
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
  const action = reservationId
    ? t("Confirmar el cambio", "Confirmar o cambio")
    : t("Confirmar reserva", "Confirmar reserva");
  const slot = intervalLabel(startsAt, endsAt, unit.data.timeZone, locale);
  return (
    <div className={booking.page}>
      {reservationId ? (
        <BackLink to={back}>{t("Cambiar horario", "Cambiar horario")}</BackLink>
      ) : (
        <BookingSteps
          current={4}
          tenantId={tenantId}
          municipality={municipality.data?.name}
          facility={{ id: unit.data.facilityId, name: facility }}
          unit={unit.data}
          slot={slot}
          query={query}
        />
      )}
      <header className={booking.intro}>
        <h1 className={booking.title}>
          {reservationId
            ? t("Revisa el cambio", "Revisa o cambio")
            : t("Revisa tu reserva", "Revisa a túa reserva")}
        </h1>
        {!reservationId && (
          <>
            <p className={booking.lead}>
              {t(
                "Comprueba los datos, lee las condiciones y confirma. Hasta entonces no hay nada reservado.",
                "Comproba os datos, le as condicións e confirma. Ata entón non hai nada reservado.",
              )}
            </p>
            <div className={booking.introActions}>
              <Link className={booking.textLink} to={back}>
                {t("Cambiar día u hora", "Cambiar día ou hora")}
              </Link>
            </div>
          </>
        )}
      </header>
      <div className={booking.split}>
        <BookingSummary
          context={[municipality.data?.name, facility]
            .filter(Boolean)
            .join(" · ")}
          unitName={unit.data.name}
          startsAt={startsAt}
          endsAt={endsAt}
          timeZone={unit.data.timeZone}
        >
          {original.data && (
            <p className={booking.summaryAction}>
              {t("Sustituye a", "Substitúe a")}{" "}
              {intervalLabel(
                original.data.startsAt,
                original.data.endsAt,
                original.data.timeZone,
                locale,
              )}
            </p>
          )}
        </BookingSummary>
        <div className={booking.main}>
          {!reservationId &&
          failure instanceof ApiError &&
          failure.code === "SLOT_UNAVAILABLE" ? (
            <Alert
              tone="danger"
              title={t(
                "Este horario ya no está libre",
                "Este horario xa non está libre",
              )}
            >
              <p>
                {t(
                  "No hemos podido confirmar este horario: puede haberse ocupado mientras revisabas. No se ha creado ninguna reserva; elige otra hora o vuelve a intentarlo.",
                  "Non puidemos confirmar este horario: pode ocuparse mentres revisabas. Non se creou ningunha reserva; escolle outra hora ou volve intentalo.",
                )}
              </p>
              <p>
                <Link className={booking.textLink} to={back}>
                  {t("Elegir otra hora", "Escoller outra hora")}
                </Link>
              </p>
            </Alert>
          ) : (
            failure !== undefined && <Failure error={failure} />
          )}
          {nonCancellable && (
            <Alert
              tone="warning"
              title={t(
                "Esta reserva no se podrá cancelar ni cambiar",
                "Esta reserva non se poderá cancelar nin cambiar",
              )}
            >
              {t(
                `Empieza dentro de las ${durationLabel(unit.data.cancellationMinutes)} previas al inicio, cuando ya no se admiten cancelaciones ni cambios ordinarios.`,
                `Comeza dentro das ${durationLabel(unit.data.cancellationMinutes)} previas ao inicio, cando xa non se admiten cancelacións nin cambios ordinarios.`,
              )}
            </Alert>
          )}
          <section className={booking.block}>
            <h2>{t("Cancelación", "Cancelación")}</h2>
            {!nonCancellable && (
              <p>
                {t(
                  "Puedes cancelar o cambiar la reserva hasta el",
                  "Podes cancelar ou cambiar a reserva ata o",
                )}{" "}
                <strong>
                  {dateTime(deadline, unit.data.timeZone, locale)}
                </strong>
                .
              </p>
            )}
            <ul className={booking.points}>
              {!nonCancellable && (
                <li>
                  {t(
                    "Pasado ese plazo, no podrás cancelarla ni cambiarla.",
                    "Pasado ese prazo, non poderás cancelala nin cambiala.",
                  )}
                </li>
              )}
              <li>
                {t(
                  "El ayuntamiento puede valorar una cancelación excepcional.",
                  "O concello pode valorar unha cancelación excepcional.",
                )}
              </li>
              <li>
                {t(
                  "La reserva es personal y no se transfiere. Los cambios de participantes dependen de las normas municipales.",
                  "A reserva é persoal e non se transfire. Os cambios de participantes dependen das normas municipais.",
                )}
              </li>
              <li>
                {t(
                  "No hay pagos ni penalizaciones automáticas.",
                  "Non hai pagamentos nin penalizacións automáticas.",
                )}
              </li>
            </ul>
          </section>
          <section className={booking.block} aria-labelledby="rules-heading">
            <h2 id="rules-heading">{t("Normas de uso", "Normas de uso")}</h2>
            <p>
              {t(
                "Léelas antes de confirmar. Quedará registrada la versión que aceptes.",
                "Le antes de confirmar. Quedará rexistrada a versión que aceptes.",
              )}
            </p>
            <RulesText label={t("Texto de las normas", "Texto das normas")}>
              {rules.data.text}
            </RulesText>
          </section>
          <div className={booking.confirm}>
            {rules.data.version !== unit.data.usageRulesVersion ? (
              <Failure
                error={
                  new ApiError(
                    0,
                    "CONDITIONS_CHANGED",
                    t(
                      "Las normas han cambiado mientras revisabas. Actualiza y vuelve a leerlas.",
                      "As normas cambiaron mentres revisabas. Actualiza e volve lelas.",
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
                    : `/api/municipalities/${tenantId}/reservations`
                }
                body={body}
                label={action}
                note={t(
                  "Al confirmar comprobamos de nuevo que el horario sigue libre.",
                  "Ao confirmar comprobamos de novo que o horario segue libre.",
                )}
                onFailure={async (error) => {
                  if (
                    error instanceof ApiError &&
                    [
                      "CONDITIONS_CHANGED",
                      "BOOKING_RULES_CHANGED",
                      "SLOT_UNAVAILABLE",
                    ].includes(error.code)
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
                    "He leído y acepto las normas de uso y las condiciones de cancelación.",
                    "Lin e acepto as normas de uso e as condicións de cancelación.",
                  )}
                />
                {nonCancellable && (
                  <Checkbox
                    required
                    name="nonCancellable"
                    label={t(
                      "Acepto que esta reserva no se podrá cancelar ni cambiar.",
                      "Acepto que esta reserva non se poderá cancelar nin cambiar.",
                    )}
                  />
                )}
              </ReservationAction>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
