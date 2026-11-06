import { useQuery } from "@tanstack/react-query";
import { CalendarPlus, Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { useServerOffset } from "../../app/server-clock.ts";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Alert } from "../../ui/alert/alert";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
} from "../../ui/dialog/dialog";
import { BackLink, BookingSummary, RulesText } from "../catalog/booking";
import booking from "../catalog/booking.module.css";
import { useBookingEntry } from "../catalog/journey";
import { useMunicipality } from "../catalog/municipality";
import styles from "./reservations.module.css";
import {
  dateTime,
  ReservationAction,
  reservationPath,
  useReservation,
} from "./shared";

export function ReservationDetail() {
  useMunicipalTheme(undefined);
  const { tenantId = "", reservationId = "" } = useParams();
  const { locale, t } = usePreferences();
  const { account } = useSession();
  const query = useReservation(tenantId, reservationId);
  const municipality = useMunicipality(tenantId);
  const entry = useBookingEntry();
  const unit = useQuery({
    queryKey: ["public", tenantId, query.data?.unitId, "detail-name"],
    enabled: !!query.data,
    queryFn: ({ signal }) =>
      api<{ name: string; facilityName: string }>(
        `/api/public/municipalities/${tenantId}/units/${query.data?.unitId}`,
        { signal },
        locale,
      ),
    retry: false,
  });
  const offset = useServerOffset();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now() + offset;
  if (query.isPending) return <Loading />;
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const r = query.data;
  const future =
    r.accountId === account?.accountId &&
    r.status === "CONFIRMADA" &&
    Date.parse(r.startsAt) > now;
  const deadline = new Date(
    Date.parse(r.startsAt) - r.cancellationMinutes * 60000,
  ).toISOString();
  const editable = future && now <= Date.parse(deadline);
  const facility = unit.data?.facilityName;
  const title =
    r.status === "CONFIRMADA"
      ? t("Reserva confirmada", "Reserva confirmada")
      : r.status === "CANCELADA"
        ? t("Reserva cancelada", "Reserva cancelada")
        : t("Reserva finalizada", "Reserva finalizada");
  return (
    <div className={booking.page}>
      <BackLink to="/reservas">
        {t("Mis reservas", "As miñas reservas")}
      </BackLink>
      <header className={booking.intro}>
        <h1 className={booking.title}>{title}</h1>
        {future && (
          <p className={booking.lead}>
            {editable
              ? t(
                  "La tienes guardada en Mis reservas. Desde aquí puedes cambiarla o cancelarla mientras el plazo lo permita.",
                  "Tela gardada nas Miñas reservas. Desde aquí podes cambiala ou cancelala mentres o prazo o permita.",
                )
              : t(
                  "La tienes guardada en Mis reservas.",
                  "Tela gardada nas Miñas reservas.",
                )}
          </p>
        )}
        <div className={booking.introActions}>
          <LinkButton to={entry}>
            <CalendarPlus size={16} aria-hidden="true" />
            {t("Nueva reserva", "Nova reserva")}
          </LinkButton>
        </div>
      </header>
      <div className={booking.split}>
        <BookingSummary
          context={[municipality.data?.name, facility]
            .filter(Boolean)
            .join(" · ")}
          unitName={
            unit.data?.name ?? t("Espacio reservado", "Espazo reservado")
          }
          startsAt={r.startsAt}
          endsAt={r.endsAt}
          timeZone={r.timeZone}
        >
          <Reference id={r.id} />
        </BookingSummary>
        <div className={booking.main}>
          {r.pendingUsageRulesVersion !== null && (
            <section className={booking.stack}>
              <Alert
                tone="warning"
                title={t(
                  "Tienes normas nuevas pendientes de aceptar",
                  "Tes normas novas pendentes de aceptar",
                )}
              >
                {t(
                  "El ayuntamiento ha cambiado el espacio de tu reserva. Revisa las normas del nuevo espacio.",
                  "O concello cambiou o espazo da túa reserva. Revisa as normas do novo espazo.",
                )}
              </Alert>
              <RulesText label={t("Normas pendientes", "Normas pendentes")}>
                {r.pendingUsageRulesText}
              </RulesText>
              {future ? (
                <div className={booking.confirm}>
                  <ReservationAction
                    key={`accept:${r.revision}`}
                    path={`${reservationPath(tenantId, reservationId)}/accept-usage-rules`}
                    body={{
                      expectedRevision: r.revision,
                      unitId: r.unitId,
                      usageRulesVersion: r.pendingUsageRulesVersion,
                    }}
                    label={t("Aceptar normas", "Aceptar normas")}
                    note={t(
                      "Aceptarlas no cambia el horario ni las condiciones de cancelación.",
                      "Aceptalas non cambia o horario nin as condicións de cancelación.",
                    )}
                    onFailure={async () => {
                      await query.refetch();
                    }}
                  >
                    <Checkbox
                      required
                      label={t(
                        "He leído y acepto las normas de este espacio.",
                        "Lin e acepto as normas deste espazo.",
                      )}
                    />
                  </ReservationAction>
                </div>
              ) : (
                <p className={styles.note}>
                  {t(
                    "El plazo para aceptarlas ha terminado. Contacta con el ayuntamiento; la reserva no se cancela automáticamente.",
                    "O prazo para aceptalas rematou. Contacta co concello; a reserva non se cancela automaticamente.",
                  )}
                </p>
              )}
            </section>
          )}
          <section className={booking.block}>
            <h2>{t("Cancelación y cambios", "Cancelación e cambios")}</h2>
            {r.status === "CANCELADA" ? (
              <p>
                {t(
                  "La reserva está cancelada y el horario ha quedado libre.",
                  "A reserva está cancelada e o horario quedou libre.",
                )}
              </p>
            ) : r.status === "FINALIZADA" ? (
              <p>
                {t(
                  "El horario ya ha pasado. Este estado no acredita la asistencia.",
                  "O horario xa pasou. Este estado non acredita a asistencia.",
                )}
              </p>
            ) : editable ? (
              <>
                <p>
                  {t(
                    "Puedes cancelar o cambiar la reserva hasta el",
                    "Podes cancelar ou cambiar a reserva ata o",
                  )}{" "}
                  <strong>{dateTime(deadline, r.timeZone, locale)}</strong>.
                </p>
                <div className={styles.actions}>
                  <Link
                    className={styles.linkButton}
                    to={`/reservas/${tenantId}/${reservationId}/modificar`}
                  >
                    {t("Cambiar horario", "Cambiar horario")}
                  </Link>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="ghost">
                        {t("Cancelar reserva", "Cancelar reserva")}
                      </Button>
                    </DialogTrigger>
                    <DialogContent
                      closeLabel={t("Cerrar", "Pechar")}
                      title={t(
                        "¿Cancelar esta reserva?",
                        "Cancelar esta reserva?",
                      )}
                      description={t(
                        "El horario quedará libre para otras personas. No se puede deshacer.",
                        "O horario quedará libre para outras persoas. Non se pode desfacer.",
                      )}
                    >
                      <ReservationAction
                        key={`cancel:${r.revision}`}
                        path={`${reservationPath(tenantId, reservationId)}/cancel`}
                        body={{ expectedRevision: r.revision }}
                        label={t("Cancelar reserva", "Cancelar reserva")}
                        danger
                        secondary={
                          <DialogClose asChild>
                            <Button type="button" variant="secondary">
                              {t("Mantener reserva", "Manter reserva")}
                            </Button>
                          </DialogClose>
                        }
                        onFailure={async () => {
                          await query.refetch();
                        }}
                      />
                    </DialogContent>
                  </Dialog>
                </div>
              </>
            ) : future ? (
              <p>
                {t(
                  "Ya no se puede cancelar ni cambiar. Si no puedes asistir, contacta con el ayuntamiento; la reserva mantiene el espacio ocupado y tu responsabilidad.",
                  "Xa non se pode cancelar nin cambiar. Se non podes asistir, contacta co concello; a reserva mantén o espazo ocupado e a túa responsabilidade.",
                )}
              </p>
            ) : (
              <p>
                {t("Plazo de cancelación:", "Prazo de cancelación:")}{" "}
                {dateTime(deadline, r.timeZone, locale)}.
              </p>
            )}
          </section>
          <section className={booking.block} aria-labelledby="accepted-rules">
            <h2 id="accepted-rules">
              {t("Normas aceptadas", "Normas aceptadas")}
            </h2>
            {r.rulesAcceptedAt && r.usageRulesText ? (
              <>
                <p>
                  {t("Aceptadas el", "Aceptadas o")}{" "}
                  {dateTime(r.rulesAcceptedAt, r.timeZone, locale)}
                  {r.usageRulesUnitId !== r.unitId &&
                    t(
                      ", para el espacio anterior al cambio.",
                      ", para o espazo anterior ao cambio.",
                    )}
                </p>
                <RulesText label={t("Normas aceptadas", "Normas aceptadas")}>
                  {r.usageRulesText}
                </RulesText>
              </>
            ) : (
              <p>
                {t(
                  "No consta una aceptación registrada. La reserva mantiene su estado.",
                  "Non consta unha aceptación rexistrada. A reserva mantén o seu estado.",
                )}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Reference({ id }: { id: string }) {
  const { t } = usePreferences();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <p className={styles.reference}>
      <span>
        {t("Referencia", "Referencia")}{" "}
        <code title={id}>{id.slice(0, 8).toUpperCase()}</code>
      </span>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(id)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
        aria-label={t(
          "Copiar referencia completa",
          "Copiar referencia completa",
        )}
      >
        {copied ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <Copy size={16} aria-hidden="true" />
        )}
      </button>
      <span role="status" className={styles.srOnly}>
        {copied ? t("Referencia copiada", "Referencia copiada") : ""}
      </span>
    </p>
  );
}
