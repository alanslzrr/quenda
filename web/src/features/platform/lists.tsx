import { Failure, Loading } from "../../app/feedback";
import { ActionLink as Link } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import styles from "../municipal/municipal.module.css";
import { More } from "../municipal/shared";
import { staffOperations } from "../municipal/staff-model";
import { PlatformAccount } from "./account";
import { type Invitation, type Operator, statuses } from "./model";
import { platformView, usePlatformPages } from "./shared";
export function Operators() {
  const { t, locale } = usePreferences();
  const q = usePlatformPages<Operator>("operators");
  return (
    <>
      <h2>{t("Operadores", "Operadores")}</h2>
      <p>
        {t(
          "El permiso es indefinido. Habilitado exige cuenta activa, correo verificado y verificación en dos pasos activada; no exige mantener una sesión abierta.",
          "O permiso é indefinido. Habilitado esixe conta activa, correo verificado e verificación en dous pasos activada; non esixe manter unha sesión aberta.",
        )}
      </p>
      <Link to={`${platformView}/invitar-operador`}>
        {t("Invitar operador", "Invitar operador")}
      </Link>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          {!q.data.pages[0].items.length && (
            <p>
              {t(
                "No hay operadores en esta consulta.",
                "Non hai operadores nesta consulta.",
              )}
            </p>
          )}
          {q.data.pages
            .flatMap((p) => p.items)
            .map((o) => (
              <section className={styles.section} key={o.accountId}>
                <h3>
                  <PlatformAccount id={o.accountId} name={o.accountName} />
                </h3>
                <p>
                  {o.revokedAt
                    ? t("Revocado", "Revogado")
                    : o.active
                      ? t("Habilitado", "Habilitado")
                      : t("No habilitado", "Non habilitado")}
                </p>
                <p>
                  {t("Concesión", "Concesión")}:{" "}
                  {new Date(o.grantedAt).toLocaleString(locale)}
                </p>
                {o.revokedAt ? (
                  <p>
                    {t("Revocación", "Revogación")}:{" "}
                    {new Date(o.revokedAt).toLocaleString(locale)}
                  </p>
                ) : (
                  <Link
                    to={`${platformView}/retirar-operador?id=${encodeURIComponent(o.accountId)}`}
                    state={{ name: o.accountName }}
                  >
                    {t(
                      "Retirar permiso de operador",
                      "Retirar permiso de operador",
                    )}
                  </Link>
                )}
              </section>
            ))}
          <More query={q} />
        </>
      )}
    </>
  );
}
export function PlatformInvitations({
  privacy = false,
}: {
  privacy?: boolean;
}) {
  const { t, locale } = usePreferences();
  const q = usePlatformPages<Invitation>(
    `${privacy ? "privacy" : "operator"}-invitations`,
  );
  return (
    <>
      <h2>
        {privacy
          ? t(
              "Concesiones de privacidad global",
              "Concesións de privacidade global",
            )
          : t("Invitaciones de operadores", "Invitacións de operadores")}
      </h2>
      <Link
        to={`${platformView}/${privacy ? "invitar-privacidad" : "invitar-operador"}`}
      >
        {privacy
          ? t("Conceder privacidad global", "Conceder privacidade global")
          : t("Invitar operador", "Invitar operador")}
      </Link>
      {!privacy && (
        <p>
          {t(
            "Una invitación aceptada no acredita el permiso actual. Consulta Operadores para comprobarlo o retirarlo.",
            "Unha invitación aceptada non acredita o permiso actual. Consulta Operadores para comprobalo ou retiralo.",
          )}
        </p>
      )}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          {!q.data.pages[0].items.length && (
            <p>
              {t(
                "No hay invitaciones en esta consulta.",
                "Non hai invitacións nesta consulta.",
              )}
            </p>
          )}
          {q.data.pages
            .flatMap((p) => p.items)
            .map((i) => (
              <section className={styles.section} key={i.invitationId}>
                <h3>
                  <PlatformAccount id={i.accountId} name={i.accountName} />
                </h3>
                <p>
                  {t("Invitación", "Invitación")}: {i.invitationId}
                </p>
                <p>
                  {t("Emisor", "Emisor")}:{" "}
                  <PlatformAccount id={i.invitedBy} name={i.invitedByName} />
                </p>
                <p>{t(...(statuses[i.status] ?? [i.status, i.status]))}</p>
                <p>
                  {t("Aceptar antes de", "Aceptar antes de")}:{" "}
                  {new Date(i.expiresAt).toLocaleString(locale)}
                </p>
                {privacy && (
                  <>
                    <p>
                      {i.roleExpiresAt
                        ? `${t("Permiso hasta", "Permiso ata")}: ${new Date(i.roleExpiresAt).toLocaleString(locale)}`
                        : t(
                            "Permiso sin caducidad automática",
                            "Permiso sen caducidade automática",
                          )}
                    </p>
                    <ul>
                      {i.permissions?.map((p) => (
                        <li key={p}>{t(...staffOperations[p])}</li>
                      ))}
                    </ul>
                    <p>{i.reason}</p>
                  </>
                )}
                {(privacy
                  ? ["PENDING", "ACTIVE"].includes(i.status)
                  : ["PENDING", "EXPIRED"].includes(i.status)) && (
                  <Link
                    to={`${platformView}/${privacy ? "retirar-privacidad" : "retirar-invitacion"}?id=${encodeURIComponent(i.invitationId)}`}
                    state={{ name: i.accountName ?? i.accountId }}
                  >
                    {t("Revocar", "Revogar")}
                  </Link>
                )}
              </section>
            ))}
          <More query={q} />
        </>
      )}
    </>
  );
}
