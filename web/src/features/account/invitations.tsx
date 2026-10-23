import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ActionForm } from "../../app/action";
import { api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Button } from "../../ui/button/button";
import { staffOperations } from "../municipal/staff-model";
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
  permissions?: (string | { operation: string; unitId: string | null })[];
}
const statuses: Record<string, [string, string]> = {
  PENDING: ["Pendiente", "Pendente"],
  ACCEPTED: ["Aceptada", "Aceptada"],
  ACTIVE: ["Activa", "Activa"],
  REVOKED: ["Revocada", "Revogada"],
  EXPIRED: ["Vencida", "Vencida"],
  INVALIDATED: ["Invalidada", "Invalidada"],
};
export function Invitations() {
  const { t } = usePreferences();
  return (
    <>
      <PageTitle title={t("Tus invitaciones", "As túas invitacións")}>
        {t(
          "Consultar una invitación no concede permisos. Para aceptarla, configura MFA y verifica el segundo factor.",
          "Consultar unha invitación non concede permisos. Para aceptala, configura MFA e verifica o segundo factor.",
        )}
      </PageTitle>
      <p>
        <Link to="/perfil/seguridad">
          {t("Configurar o verificar MFA", "Configurar ou verificar MFA")}
        </Link>
      </p>
      <InvitationList
        kind="administrator"
        title={t("Administración municipal", "Administración municipal")}
      />
      <InvitationList
        kind="manager"
        title={t("Gestión municipal", "Xestión municipal")}
      />
      <InvitationList
        kind="operator"
        title={t("Operación de plataforma", "Operación de plataforma")}
      />
      <InvitationList
        kind="privacy"
        title={t("Privacidad global", "Privacidade global")}
      />
    </>
  );
}
function InvitationList({ kind, title }: { kind: Kind; title: string }) {
  const { account } = useSession();
  const { t, locale } = usePreferences();
  const client = useQueryClient();
  const query = useInfiniteQuery({
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
  return (
    <section className={styles.section}>
      <h2>{title}</h2>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <ul className={styles.list}>
            {query.data.pages
              .flatMap((page) => page.items)
              .map((item) => (
                <li className={styles.listItem} key={item.invitationId}>
                  <h3>
                    {item.municipality ?? t("Esta instancia", "Esta instancia")}
                  </h3>
                  <p>
                    {t(
                      ...(statuses[item.status] ?? [item.status, item.status]),
                    )}
                  </p>
                  <p>
                    {t("Invitación válida hasta", "Invitación válida ata")}{" "}
                    {new Date(item.expiresAt).toLocaleString(locale)}
                  </p>
                  {"roleExpiresAt" in item && (
                    <p>
                      {item.roleExpiresAt
                        ? `${t("Permiso hasta", "Permiso ata")} ${new Date(item.roleExpiresAt).toLocaleString(locale)}`
                        : t(
                            "Permiso sin caducidad automática",
                            "Permiso sen caducidade automática",
                          )}
                    </p>
                  )}
                  {item.reason && <p>{item.reason}</p>}
                  {item.permissions && (
                    <ul>
                      {item.permissions.map((permission) => {
                        const code =
                          typeof permission === "string"
                            ? permission
                            : permission.operation;
                        return (
                          <li
                            key={`${code}-${typeof permission === "string" ? "global" : (permission.unitId ?? "municipal")}`}
                          >
                            {t(
                              ...(staffOperations[
                                code as keyof typeof staffOperations
                              ] ?? [code, code]),
                            )}
                            {typeof permission !== "string" &&
                              ` · ${permission.unitId ? `${t("Unidad", "Unidade")} ${permission.unitId}` : t("Todo el municipio", "Todo o municipio")}`}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {item.status === "PENDING" && (
                    <ActionForm
                      label={t("Aceptar invitación", "Aceptar invitación")}
                      submit={async () => {
                        const scope = item.tenantId
                          ? `/api/municipalities/${item.tenantId}`
                          : "/api/platform";
                        await api(
                          `${scope}/${kind}-invitations/${item.invitationId}/accept`,
                          { method: "POST", body: "{}" },
                          locale,
                        );
                        await query.refetch();
                        await Promise.all(
                          ["platform-context", "privacy-navigation"].map(
                            (key) =>
                              client.invalidateQueries({
                                queryKey: ["private", account?.accountId, key],
                              }),
                          ),
                        );
                        await client.invalidateQueries({
                          queryKey: [
                            "private",
                            account?.accountId,
                            "municipal-context",
                          ],
                        });
                        await client.invalidateQueries({
                          queryKey: [
                            "private",
                            account?.accountId,
                            "navigation",
                          ],
                        });
                      }}
                    />
                  )}
                </li>
              ))}
          </ul>
          {query.data.pages[0].items.length === 0 && (
            <p>
              {t(
                "No tienes invitaciones en este ámbito.",
                "Non tes invitacións neste ámbito.",
              )}
            </p>
          )}
          {query.hasNextPage && (
            <Button
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("Ver más", "Ver máis")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
