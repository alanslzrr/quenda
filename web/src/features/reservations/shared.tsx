import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ActionForm } from "../../app/action";
import { api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import { PageTitle } from "../account/shared";
import { calendarDate, municipalToday, slotLabel } from "../catalog/dates";
import {
  type CommandPolicy,
  type CommandResult,
  commandResultPath,
  commandReviewPath,
  forgetCommand,
  readCommand,
  retryAllowed,
  sendCommand,
} from "./commands";
export interface Reservation {
  accountId?: string;
  id: string;
  tenantId: string;
  unitId: string;
  startsAt: string;
  endsAt: string;
  status: "CONFIRMADA" | "CANCELADA" | "FINALIZADA";
  revision: number;
  timeZone: string;
  cancellationMinutes: number;
  usageRulesUnitId: string | null;
  usageRulesVersion: number | null;
  rulesAcceptedAt: string | null;
  usageRulesText: string | null;
  pendingUsageRulesVersion: number | null;
  pendingUsageRulesText: string | null;
  bookingPolicyVersion: number | null;
}
export const reservationPath = (tenant: string, id: string) =>
  `/api/municipalities/${tenant}/reservations/${id}`;
export const detailPath = (tenant: string, id: string) =>
  `/reservas/${tenant}/${id}`;
export function useReservation(tenant: string, id: string) {
  const { account } = useSession();
  const { locale } = usePreferences();
  return useQuery({
    queryKey: [
      "private",
      account?.accountId,
      "reservation",
      tenant,
      id,
      locale,
    ],
    enabled: !!id,
    queryFn: ({ signal }) =>
      api<Reservation>(reservationPath(tenant, id), { signal }, locale),
  });
}
export function dateTime(value: string, timeZone: string, locale: string) {
  const date = new Date(value);
  const offset =
    new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${calendarLabel(calendarDate(municipalToday(timeZone, date)), locale, "long")} · ${slotLabel(value, timeZone, locale)} ${offset.replace("GMT", "UTC")}`;
}
export function ReservationSummary({
  reservation: r,
}: {
  reservation: Pick<Reservation, "startsAt" | "endsAt" | "timeZone">;
}) {
  const { locale } = usePreferences();
  return (
    <p>
      {dateTime(r.startsAt, r.timeZone, locale)} —{" "}
      {dateTime(r.endsAt, r.timeZone, locale)}
      <br />
      <small>{r.timeZone}</small>
    </p>
  );
}
export function PendingLink() {
  const { account } = useSession();
  const { t } = usePreferences();
  const pending = account && readCommand(account.accountId);
  return pending ? (
    <p role="status">
      <Link to="/reservas/recuperacion">
        {t(
          "Hay una operación sin resultado confirmado. Revisar operación.",
          "Hai unha operación sen resultado confirmado. Revisar operación.",
        )}
      </Link>
    </p>
  ) : null;
}
export function ReservationAction({
  path,
  body,
  label,
  children,
  onFailure,
}: {
  path: string;
  body: unknown;
  label: string;
  children: ReactNode;
  onFailure?: (error: unknown) => Promise<void>;
}) {
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [uncertain, setUncertain] = useState(false);
  if (uncertain || (account && readCommand(account.accountId)))
    return <PendingLink />;
  return (
    <ActionForm
      label={label}
      submit={async () => {
        if (!account) return;
        const policy = await api<CommandPolicy>(
          "/api/public/reservation-command-policy",
          {},
          locale,
        );
        const item = {
          owner: account.accountId,
          path,
          key: crypto.randomUUID(),
          body: JSON.stringify(body),
          createdAt: Date.parse(policy.serverTime),
          retentionSeconds: policy.retentionSeconds,
        };
        try {
          const result = await sendCommand<Reservation>(item, locale);
          await client.invalidateQueries({ queryKey: ["public"] });
          await client.invalidateQueries({
            queryKey: ["private", account.accountId],
          });
          navigate(detailPath(result.tenantId, result.id), { replace: true });
        } catch (error) {
          if (readCommand(account.accountId)) {
            setUncertain(true);
            return;
          }
          await onFailure?.(error);
          throw error;
        }
      }}
    >
      {children}
      <p>
        {t(
          "La operación se confirma con la respuesta del sistema.",
          "A operación confírmase coa resposta do sistema.",
        )}
      </p>
    </ActionForm>
  );
}
export function CommandRecovery() {
  useMunicipalTheme(undefined);
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [version, setVersion] = useState(0);
  const pending = account ? readCommand(account.accountId) : null;
  const policy = useQuery({
    queryKey: ["public", "command-policy", version],
    queryFn: ({ signal }) =>
      api<CommandPolicy>(
        "/api/public/reservation-command-policy",
        { signal },
        locale,
      ),
    staleTime: 0,
  });
  return (
    <>
      <PageTitle title={t("Revisar operación", "Revisar operación")} />
      <Link to={pending ? commandReviewPath(pending) : "/reservas"}>
        {t("Consultar estado actual", "Consultar estado actual")}
      </Link>
      {!pending ? (
        <p>
          {t(
            "No hay operaciones pendientes de comprobar.",
            "Non hai operacións pendentes de comprobar.",
          )}
        </p>
      ) : (
        <section className={styles.section}>
          <p>
            {t(
              "No se recibió una confirmación. La operación puede haberse completado. Consulta el estado actual antes de enviar otra solicitud.",
              "Non se recibiu unha confirmación. A operación pode terse completado. Consulta o estado actual antes de enviar outra solicitude.",
            )}
          </p>
          {policy.isPending ? (
            <Loading />
          ) : policy.isError ? (
            <Failure error={policy.error} />
          ) : retryAllowed(
              pending,
              Date.now(),
              policy.data.retentionSeconds,
            ) ? (
            <ActionForm
              label={t(
                "Comprobar con la misma solicitud",
                "Comprobar coa mesma solicitude",
              )}
              submit={async () => {
                const result = await sendCommand<CommandResult>(
                  pending,
                  locale,
                  true,
                );
                await client.invalidateQueries();
                navigate(commandResultPath(pending, result), {
                  replace: true,
                });
              }}
            />
          ) : (
            <p>
              {t(
                "El plazo de reintento ha terminado. No se reenviará la operación. Si el resultado no está claro, contacta con el municipio.",
                "O prazo de reintento rematou. Non se reenviará a operación. Se o resultado non está claro, contacta co municipio.",
              )}
            </p>
          )}
          <h2>{t("Cerrar la comprobación", "Pechar a comprobación")}</h2>
          <ActionForm
            label={t("Cerrar comprobación", "Pechar comprobación")}
            submit={async () => {
              forgetCommand();
              setVersion(version + 1);
            }}
          >
            <Checkbox
              required
              label={t(
                "He comprobado el resultado en la sección correspondiente o con el municipio.",
                "Comprobei o resultado na sección correspondente ou co municipio.",
              )}
            />
          </ActionForm>
        </section>
      )}
    </>
  );
}
