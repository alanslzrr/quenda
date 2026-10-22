import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { PageTitle } from "../account/shared";
import {
  dateTime,
  ReservationAction,
  ReservationSummary,
  reservationPath,
  useReservation,
} from "./shared";
export function ReservationDetail() {
  useMunicipalTheme(undefined);
  const { tenantId = "", reservationId = "" } = useParams();
  const { locale, t } = usePreferences();
  const { account } = useSession();
  const query = useReservation(tenantId, reservationId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (query.isPending) return <Loading />;
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const r = query.data;
  const future =
    r.accountId === account?.accountId &&
    r.status === "CONFIRMADA" &&
    Date.parse(r.startsAt) > now;
  const deadline = Date.parse(r.startsAt) - r.cancellationMinutes * 60000;
  const editable = future && now <= deadline;
  return (
    <>
      <Link to="/reservas">{t("Mis reservas", "As miñas reservas")}</Link>
      <PageTitle title={t("Detalle de la reserva", "Detalle da reserva")} />
      <section className={styles.section}>
        <p role="status">
          <strong>
            {r.status === "CONFIRMADA"
              ? t("Confirmada", "Confirmada")
              : r.status === "CANCELADA"
                ? t("Cancelada", "Cancelada")
                : t("Finalizada", "Finalizada")}
          </strong>
        </p>
        <ReservationSummary reservation={r} />
        <p>
          {t("Referencia", "Referencia")}: {r.id}
        </p>
        <p>
          {t("Unidad reservable", "Unidade reservable")}:{" "}
          <Link to={`/municipios/${tenantId}/unidades/${r.unitId}`}>
            {r.unitId}
          </Link>
        </p>
        <p>
          {t("Cancelación ordinaria hasta:", "Cancelación ordinaria ata:")}{" "}
          {dateTime(new Date(deadline).toISOString(), r.timeZone, locale)}.
        </p>
        {r.status === "FINALIZADA" && (
          <p>
            {t(
              "El intervalo ha terminado. Este estado no acredita asistencia.",
              "O intervalo rematou. Este estado non acredita asistencia.",
            )}
          </p>
        )}
        {r.status === "CONFIRMADA" && !editable && (
          <p>
            {t(
              "La cancelación y modificación ordinarias ya no están disponibles. Si no puedes asistir, contacta con el municipio. La reserva mantiene su ocupación y tu responsabilidad.",
              "A cancelación e modificación ordinarias xa non están dispoñibles. Se non podes asistir, contacta co municipio. A reserva mantén a súa ocupación e a túa responsabilidade.",
            )}
          </p>
        )}
        <h2>{t("Normas aceptadas", "Normas aceptadas")}</h2>
        {r.rulesAcceptedAt && r.usageRulesVersion !== null ? (
          <>
            <p>
              {t("Unidad", "Unidade")}: {r.usageRulesUnitId} ·{" "}
              {t("versión", "versión")} {r.usageRulesVersion} ·{" "}
              {dateTime(r.rulesAcceptedAt, r.timeZone, locale)}
            </p>
            <p style={{ whiteSpace: "pre-wrap" }}>{r.usageRulesText}</p>
          </>
        ) : (
          <p>
            {t(
              "Sin aceptación registrada. La reserva conserva su estado.",
              "Sen aceptación rexistrada. A reserva conserva o seu estado.",
            )}
          </p>
        )}
      </section>
      {r.pendingUsageRulesVersion !== null && (
        <section className={styles.section}>
          <h2>
            {t(
              "Normas pendientes de aceptación",
              "Normas pendentes de aceptación",
            )}
          </h2>
          <p>
            {t("Unidad", "Unidade")}: {r.unitId} · {t("versión", "versión")}{" "}
            {r.pendingUsageRulesVersion}
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{r.pendingUsageRulesText}</p>
          {future ? (
            <ReservationAction
              key={`accept:${r.revision}`}
              path={`${reservationPath(tenantId, reservationId)}/accept-usage-rules`}
              body={{
                expectedRevision: r.revision,
                unitId: r.unitId,
                usageRulesVersion: r.pendingUsageRulesVersion,
              }}
              label={t("Aceptar normas", "Aceptar normas")}
              onFailure={async () => {
                await query.refetch();
              }}
            >
              <Checkbox
                required
                label={t(
                  "Acepto las normas indicadas para esta unidad y versión.",
                  "Acepto as normas indicadas para esta unidade e versión.",
                )}
              />
              <p>
                {t(
                  "Esta aceptación no cambia el horario ni las condiciones de cancelación.",
                  "Esta aceptación non cambia o horario nin as condicións de cancelación.",
                )}
              </p>
            </ReservationAction>
          ) : (
            <p>
              {t(
                "El plazo de aceptación ha terminado. Contacta con el municipio; la reserva no se cancela automáticamente.",
                "O prazo de aceptación rematou. Contacta co municipio; a reserva non se cancela automaticamente.",
              )}
            </p>
          )}
        </section>
      )}
      {editable && (
        <section className={styles.section}>
          <h2>{t("Gestionar reserva", "Xestionar reserva")}</h2>
          <Link to={`/reservas/${tenantId}/${reservationId}/modificar`}>
            {t("Modificar reserva", "Modificar reserva")}
          </Link>
          <h3>{t("Cancelar reserva", "Cancelar reserva")}</h3>
          <ReservationAction
            key={`cancel:${r.revision}`}
            path={`${reservationPath(tenantId, reservationId)}/cancel`}
            body={{ expectedRevision: r.revision }}
            label={t("Cancelar reserva", "Cancelar reserva")}
            onFailure={async () => {
              await query.refetch();
            }}
          >
            <Checkbox
              required
              label={t(
                "Quiero cancelar esta reserva y liberar la franja.",
                "Quero cancelar esta reserva e liberar a franxa.",
              )}
            />
          </ReservationAction>
        </section>
      )}
    </>
  );
}
