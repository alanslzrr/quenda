import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { MailOpen } from "lucide-react";
import { Link } from "react-router";
import { ActionForm } from "../../app/action";
import { api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Badge } from "../../ui/badge/badge";
import { Button } from "../../ui/button/button";
import { EmptyState } from "../../ui/empty-state/empty-state";
import { browserTimeZone, compareText } from "../../ui/lib/intl-cache.ts";
import { staffOperations } from "../municipal/staff-model";
import { dateTime } from "../reservations/shared";
import styles from "./invitations.module.css";
import { PageTitle } from "./shared";

type Kind = "administrator" | "manager" | "operator" | "privacy";
interface Invitation {
  invitationId: string;
  tenantId?: string;
  municipality?: string;
  status: string;
  expiresAt: string;
  roleExpiresAt?: string | null;
  reason?: string;
  permissions?: (
    | string
    | { operation: string; unitId: string | null; unitName?: string | null }
  )[];
}
type Entry = Invitation & { kind: Kind };

const statuses: Record<string, [string, string]> = {
  PENDING: ["Pendiente", "Pendente"],
  ACCEPTED: ["Aceptada", "Aceptada"],
  ACTIVE: ["Activa", "Activa"],
  REVOKED: ["Revocada", "Revogada"],
  EXPIRED: ["Vencida", "Vencida"],
  INVALIDATED: ["Invalidada", "Invalidada"],
};
const tone = (status: string) =>
  status === "PENDING"
    ? "warning"
    : status === "ACCEPTED" || status === "ACTIVE"
      ? "success"
      : "neutral";
const kinds: Kind[] = ["administrator", "manager", "operator", "privacy"];

function useInvitations(kind: Kind) {
  const { account } = useSession();
  const { locale } = usePreferences();
  return useInfiniteQuery({
    queryKey: ["private", account?.accountId, "invitations", kind],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<Invitation>>(
        `/api/me/${kind}-invitations${pageParam ? `?after=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** Every role invitation of the account in one place: what waits for an answer first, then the history. */
export function Invitations() {
  const { t } = usePreferences();
  const lists = {
    administrator: useInvitations("administrator"),
    manager: useInvitations("manager"),
    operator: useInvitations("operator"),
    privacy: useInvitations("privacy"),
  };
  const queries = kinds.map((kind) => lists[kind]);
  const failed = queries.find((query) => query.isError);
  const entries: Entry[] = kinds.flatMap((kind) =>
    (lists[kind].data?.pages.flatMap((page) => page.items) ?? []).map(
      (item) => ({ ...item, kind }),
    ),
  );
  const pending = entries.filter((entry) => entry.status === "PENDING");
  const history = entries
    .filter((entry) => entry.status !== "PENDING")
    .sort((a, b) => compareText(b.expiresAt, a.expiresAt));
  const more = queries.filter((query) => query.hasNextPage);
  return (
    <>
      <PageTitle title={t("Tus invitaciones", "As túas invitacións")}>
        {t(
          "Invitaciones para gestionar o administrar en Quenda: las enviadas a tu correo verificado y las dirigidas directamente a tu cuenta. Si cambias el correo, verás las enviadas a la nueva dirección y dejarás de ver las pendientes de la anterior. Consultarlas no concede permisos: solo aceptarlas.",
          "Invitacións para xestionar ou administrar en Quenda: as enviadas ao teu correo verificado e as dirixidas directamente á túa conta. Se cambias o correo, verás as enviadas ao novo enderezo e deixarás de ver as pendentes do anterior. Consultalas non concede permisos: só aceptalas.",
        )}
      </PageTitle>
      {failed && (
        <Failure
          error={failed.error}
          retry={() => {
            for (const query of queries)
              if (query.isError) void query.refetch();
          }}
        />
      )}
      {queries.some((query) => query.isPending) ? (
        <Loading />
      ) : !entries.length ? (
        // With a list that failed to load, "no invitations" would be a claim the page cannot make.
        failed ? null : (
          <EmptyState
            icon={<MailOpen width={24} height={24} strokeWidth={1.5} />}
            title={t("No tienes invitaciones", "Non tes invitacións")}
            description={t(
              "Cuando un municipio te invite a gestionar o administrar, la invitación aparecerá aquí.",
              "Cando un municipio te convide a xestionar ou administrar, a invitación aparecerá aquí.",
            )}
            headingLevel={2}
          />
        )
      ) : (
        <>
          {pending.length > 0 && (
            <section
              className={styles.section}
              aria-labelledby="invitations-pending"
            >
              <h2 id="invitations-pending" className={styles.sectionTitle}>
                {t("Pendientes de aceptar", "Pendentes de aceptar")}
              </h2>
              <p className={styles.hint}>
                {t(
                  "Para aceptar necesitas la verificación en dos pasos activada y completada en esta sesión.",
                  "Para aceptar necesitas a verificación en dous pasos activada e completada nesta sesión.",
                )}{" "}
                <Link to="/perfil/seguridad">
                  {t("Configurarla", "Configurala")}
                </Link>
              </p>
              <ul className={styles.list}>
                {pending.map((entry) => (
                  <InvitationCard
                    key={`${entry.kind}:${entry.invitationId}`}
                    entry={entry}
                  />
                ))}
              </ul>
            </section>
          )}
          {history.length > 0 && (
            <section
              className={styles.section}
              aria-labelledby="invitations-history"
            >
              <h2 id="invitations-history" className={styles.sectionTitle}>
                {t("Historial", "Historial")}
              </h2>
              <ul className={styles.list}>
                {history.map((entry) => (
                  <InvitationCard
                    key={`${entry.kind}:${entry.invitationId}`}
                    entry={entry}
                  />
                ))}
              </ul>
            </section>
          )}
          {more.length > 0 && (
            <Button
              variant="secondary"
              loading={more.some((query) => query.isFetchingNextPage)}
              onClick={() => {
                for (const query of more) void query.fetchNextPage();
              }}
            >
              {t("Ver más", "Ver máis")}
            </Button>
          )}
        </>
      )}
    </>
  );
}

function InvitationCard({ entry }: { entry: Entry }) {
  const { account } = useSession();
  const { t, locale } = usePreferences();
  const client = useQueryClient();
  const zone = browserTimeZone();
  const date = (value: string) => dateTime(value, zone, locale);
  const role = {
    administrator: t("Administración municipal", "Administración municipal"),
    manager: t("Gestión municipal", "Xestión municipal"),
    operator: t("Operación de plataforma", "Operación de plataforma"),
    privacy: t("Privacidad global", "Privacidade global"),
  }[entry.kind];
  const where = entry.municipality ?? t("Esta instancia", "Esta instancia");
  const pending = entry.status === "PENDING";
  const granted = entry.status === "ACCEPTED" || entry.status === "ACTIVE";
  const facts: string[] = [];
  if (pending)
    facts.push(
      t(
        `Puedes aceptarla hasta el ${date(entry.expiresAt)}`,
        `Podes aceptala ata o ${date(entry.expiresAt)}`,
      ),
    );
  if ((pending || granted) && "roleExpiresAt" in entry)
    facts.push(
      entry.roleExpiresAt
        ? t(
            `El permiso dura hasta el ${date(entry.roleExpiresAt)}`,
            `O permiso dura ata o ${date(entry.roleExpiresAt)}`,
          )
        : t("El permiso no caduca solo", "O permiso non caduca só"),
    );
  if (entry.status === "EXPIRED")
    facts.push(
      t(
        `Venció el ${date(entry.expiresAt)}`,
        `Venceu o ${date(entry.expiresAt)}`,
      ),
    );
  return (
    <li className={styles.card} data-pending={pending || undefined}>
      <div className={styles.head}>
        <div>
          <h3 className={styles.title}>{role}</h3>
          <p className={styles.where}>{where}</p>
        </div>
        <Badge size="sm" tone={tone(entry.status)}>
          {t(...(statuses[entry.status] ?? [entry.status, entry.status]))}
        </Badge>
      </div>
      {facts.length > 0 && (
        <ul className={styles.facts}>
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
      {entry.reason && <p className={styles.reason}>{entry.reason}</p>}
      {entry.permissions && entry.permissions.length > 0 && (
        <ul
          className={styles.permissions}
          aria-label={t("Permisos", "Permisos")}
        >
          {entry.permissions.map((permission) => {
            const code =
              typeof permission === "string"
                ? permission
                : permission.operation;
            const scope =
              typeof permission === "string"
                ? undefined
                : permission.unitId
                  ? (permission.unitName ??
                    t("Un espacio retirado", "Un espazo retirado"))
                  : t("Todo el municipio", "Todo o municipio");
            return (
              <li
                key={`${code}-${typeof permission === "string" ? "global" : (permission.unitId ?? "municipal")}`}
              >
                {t(
                  ...(staffOperations[code as keyof typeof staffOperations] ?? [
                    code,
                    code,
                  ]),
                )}
                {scope && <span className={styles.scope}>{scope}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {pending && (
        <ActionForm
          label={t("Aceptar invitación", "Aceptar invitación")}
          submit={async () => {
            const scope = entry.tenantId
              ? `/api/municipalities/${entry.tenantId}`
              : "/api/platform";
            await api(
              `${scope}/${entry.kind}-invitations/${entry.invitationId}/accept`,
              { method: "POST", body: "{}" },
              locale,
            );
            await client.invalidateQueries({
              queryKey: [
                "private",
                account?.accountId,
                "invitations",
                entry.kind,
              ],
            });
            await Promise.all(
              [
                "platform-context",
                "privacy-navigation",
                "municipal-context",
                "navigation",
              ].map((key) =>
                client.invalidateQueries({
                  queryKey: ["private", account?.accountId, key],
                }),
              ),
            );
          }}
        />
      )}
    </li>
  );
}
