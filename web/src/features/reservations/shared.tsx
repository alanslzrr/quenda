import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ActionForm } from "../../app/action";
import { restoreFocus } from "../../app/announce";
import { api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import { PageTitle } from "../account/shared";
import {
  calendarDate,
  endsNextDay,
  intervalLabel,
  localTimeLabel,
  municipalToday,
} from "../catalog/dates";
import {
  type CommandPolicy,
  type CommandResult,
  commandResultPath,
  commandReviewPath,
  commandTime,
  forgetCommand,
  readCommand,
  retryAllowed,
  sendCommand,
} from "./commands";
import local from "./reservations.module.css";
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
  /** Only in the reservation detail. */
  arrivedAt?: string | null;
  /** Only in the reservation detail, also for a withdrawn space; null only if the space no longer exists. */
  municipalityName?: string | null;
  facilityName?: string | null;
  unitName?: string | null;
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
    enabled: !!account && !!id,
    queryFn: ({ signal }) =>
      api<Reservation>(reservationPath(tenant, id), { signal }, locale),
  });
}
export function dateTime(value: string, timeZone: string, locale: string) {
  const date = new Date(value);
  return `${calendarLabel(calendarDate(municipalToday(timeZone, date)), locale, "long")} · ${localTimeLabel(value, timeZone, locale)}`;
}
export function ReservationSummary({
  reservation: r,
}: {
  reservation: Pick<Reservation, "startsAt" | "endsAt" | "timeZone">;
}) {
  const { locale, t } = usePreferences();
  return (
    <p>
      {intervalLabel(r.startsAt, r.endsAt, r.timeZone, locale)}
      {endsNextDay(r.startsAt, r.endsAt, r.timeZone) &&
        ` · ${t("termina al día siguiente", "remata ao día seguinte")}`}
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
/**
 * A reservation command. `revision` is the reservation state the body was built from: when a refresh changes it, the
 * fields start over for the new state (a consent given for the old one does not carry over) while the failure that
 * caused the refresh stays visible, so the person can read why it failed and retry against the current state. The
 * owner keeps this component mounted across that refresh and passes `unavailable` when the action no longer applies.
 */
export function ReservationAction({
  path,
  body,
  label,
  children,
  onFailure,
  onSuccess,
  note,
  danger,
  secondary,
  revision,
  unavailable,
}: {
  path: string;
  body: unknown;
  label: string;
  children?: ReactNode;
  onFailure?: (error: unknown) => Promise<void>;
  /** Runs once the command is confirmed, before the reservation page is shown. */
  onSuccess?: () => void;
  note?: string;
  danger?: boolean;
  secondary?: ReactNode;
  revision?: number;
  unavailable?: string;
}) {
  const { account } = useSession();
  const { locale } = usePreferences();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [uncertain, setUncertain] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown }>();
  if (uncertain || (account && readCommand(account.accountId)))
    return <PendingLink />;
  return (
    <ActionForm
      key={revision}
      initialError={failure?.error}
      label={label}
      danger={danger}
      secondary={secondary}
      unavailable={unavailable}
      submit={async () => {
        if (!account) return;
        setFailure(undefined);
        const policy = await api<CommandPolicy>(
          "/api/public/reservation-command-policy",
          { signal: AbortSignal.timeout(15000) },
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
          onSuccess?.();
          navigate(detailPath(result.tenantId, result.id), { replace: true });
          restoreFocus();
        } catch (error) {
          if (readCommand(account.accountId)) {
            setUncertain(true);
            return;
          }
          // Held before the refresh, so a form rebuilt for the new revision still shows it.
          setFailure({ error });
          await onFailure?.(error);
          throw error;
        }
      }}
    >
      {children}
      {note && <p className={local.note}>{note}</p>}
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
    queryFn: async ({ signal }) => {
      const value = await api<CommandPolicy>(
        "/api/public/reservation-command-policy",
        { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) },
        locale,
      );
      commandTime(value, pending?.createdAt);
      return { ...value, receivedAt: performance.now() };
    },
    staleTime: 0,
  });
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
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
            <Failure error={policy.error} retry={() => void policy.refetch()} />
          ) : retryAllowed(
              pending,
              Date.parse(policy.data.serverTime) +
                Math.max(0, performance.now() - policy.data.receivedAt),
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
                  state: { commandResult: result },
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
