import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { usePublicAppearance } from "../../app/branding";
import { useClockBoundaries } from "../../app/clock-boundaries";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { serverNow } from "../../app/server-clock.ts";
import { useSession } from "../../app/session";
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
import { AccessPass } from "./access-code";
import { accessCodeTarget } from "./access-code-model";
import { cancellation, placeContext, placeUnitName } from "./detail-model";
import styles from "./reservations.module.css";
import {
  dateTime,
  ReservationAction,
  reservationPath,
  useReservation,
} from "./shared";

export function ReservationDetail() {
  const { tenantId = "", reservationId = "" } = useParams();
  // A reservation is shown in the theme of the municipality it belongs to.
  usePublicAppearance(tenantId);
  const { locale, t } = usePreferences();
  const { account } = useSession();
  const query = useReservation(tenantId, reservationId);
  // Controlled so the dialog outlives a refresh that ends the cancellation (changed or cancelled elsewhere): it then
  // explains why instead of vanishing with the failure it was showing.
  const [cancelling, setCancelling] = useState(false);
  // Likewise, a failed acceptance stays on the page after a refresh that leaves nothing to accept.
  const [acceptFailed, setAcceptFailed] = useState(false);
  // The page changes only when the cancellation deadline and the start pass, so it re-renders then
  // rather than every second.
  const startsAt = Date.parse(query.data?.startsAt ?? "");
  useClockBoundaries(
    [
      startsAt - (query.data?.cancellationMinutes ?? Number.NaN) * 60000,
      startsAt,
    ],
    serverNow,
  );
  const now = serverNow();
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
  const cancel = cancellation(r, r.accountId === account?.accountId, now);
  const editable = cancel === "allowed";
  const acceptable = future && r.pendingUsageRulesVersion !== null;
  const unitName = placeUnitName(r, t("Espacio reservado", "Espazo reservado"));
  const context = placeContext(r);
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
        {r.accountId === account?.accountId && r.status !== "FINALIZADA" && (
          <div className={booking.introActions}>
            <a
              className={booking.textLink}
              href={`${reservationPath(tenantId, reservationId)}/calendar.ics?lang=${locale}`}
              download
              title={t(
                "Archivo .ics para Google Calendar, Outlook o Calendario de Apple",
                "Ficheiro .ics para Google Calendar, Outlook ou Calendario de Apple",
              )}
            >
              {r.status === "CANCELADA"
                ? t("Quitar de mi calendario", "Quitar do meu calendario")
                : t("Añadir a mi calendario", "Engadir ao meu calendario")}
            </a>
          </div>
        )}
      </header>
      <div className={booking.split}>
        <BookingSummary
          context={context}
          unitName={unitName}
          startsAt={r.startsAt}
          endsAt={r.endsAt}
          timeZone={r.timeZone}
        >
          <Reference id={r.id} />
        </BookingSummary>
        <div className={booking.main}>
          {r.accountId === account?.accountId &&
            (r.status === "CONFIRMADA" || r.arrivedAt) && (
              <section className={booking.block}>
                <h2>{t("Acceso a la instalación", "Acceso á instalación")}</h2>
                {r.arrivedAt ? (
                  <p>
                    {t("Llegada registrada:", "Chegada rexistrada:")}{" "}
                    {dateTime(r.arrivedAt, r.timeZone, locale)}
                  </p>
                ) : (
                  <AccessPass
                    value={accessCodeTarget(
                      window.location.origin,
                      tenantId,
                      reservationId,
                    )}
                    unitName={unitName}
                    context={context}
                    startsAt={r.startsAt}
                    endsAt={r.endsAt}
                    timeZone={r.timeZone}
                    reference={r.id}
                  />
                )}
              </section>
            )}
          {(r.pendingUsageRulesVersion !== null || acceptFailed) && (
            <section className={booking.stack}>
              {r.pendingUsageRulesVersion !== null && (
                <>
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
                </>
              )}
              {acceptable || acceptFailed ? (
                <div className={booking.confirm}>
                  <ReservationAction
                    revision={r.revision}
                    path={`${reservationPath(tenantId, reservationId)}/accept-usage-rules`}
                    body={{
                      expectedRevision: r.revision,
                      unitId: r.unitId,
                      usageRulesVersion: r.pendingUsageRulesVersion,
                    }}
                    label={t("Aceptar normas", "Aceptar normas")}
                    note={
                      acceptable
                        ? t(
                            "Aceptarlas no cambia el horario ni las condiciones de cancelación.",
                            "Aceptalas non cambia o horario nin as condicións de cancelación.",
                          )
                        : undefined
                    }
                    unavailable={
                      acceptable
                        ? undefined
                        : r.status === "CANCELADA"
                          ? t(
                              "La reserva ya está cancelada.",
                              "A reserva xa está cancelada.",
                            )
                          : r.pendingUsageRulesVersion === null
                            ? t(
                                "Ya no hay normas pendientes de aceptar.",
                                "Xa non hai normas pendentes de aceptar.",
                              )
                            : t(
                                "El plazo para aceptarlas ha terminado.",
                                "O prazo para aceptalas rematou.",
                              )
                    }
                    onSuccess={() => setAcceptFailed(false)}
                    onFailure={async () => {
                      setAcceptFailed(true);
                      await query.refetch();
                    }}
                  >
                    {acceptable && (
                      <Checkbox
                        required
                        label={t(
                          "He leído y acepto las normas de este espacio.",
                          "Lin e acepto as normas deste espazo.",
                        )}
                      />
                    )}
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
          <Dialog open={cancelling} onOpenChange={setCancelling}>
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
                    <DialogTrigger asChild>
                      <Button variant="danger-ghost">
                        {t("Cancelar reserva", "Cancelar reserva")}
                      </Button>
                    </DialogTrigger>
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
            <DialogContent
              closeLabel={t("Cerrar", "Pechar")}
              title={t("¿Cancelar esta reserva?", "Cancelar esta reserva?")}
              description={t(
                "El horario quedará libre para otras personas. No se puede deshacer.",
                "O horario quedará libre para outras persoas. Non se pode desfacer.",
              )}
            >
              <ReservationAction
                revision={r.revision}
                path={`${reservationPath(tenantId, reservationId)}/cancel`}
                body={{ expectedRevision: r.revision }}
                label={t("Cancelar reserva", "Cancelar reserva")}
                danger
                unavailable={
                  cancel === "cancelled"
                    ? t(
                        "La reserva ya está cancelada.",
                        "A reserva xa está cancelada.",
                      )
                    : cancel === "closed"
                      ? t(
                          "Ya no se puede cancelar: el plazo ha terminado.",
                          "Xa non se pode cancelar: o prazo rematou.",
                        )
                      : undefined
                }
                secondary={
                  <DialogClose asChild>
                    <Button type="button" variant="secondary" data-autofocus="">
                      {editable
                        ? t("Mantener reserva", "Manter reserva")
                        : t("Cerrar", "Pechar")}
                    </Button>
                  </DialogClose>
                }
                onSuccess={() => setCancelling(false)}
                onFailure={async () => {
                  await query.refetch();
                }}
              />
            </DialogContent>
          </Dialog>
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
