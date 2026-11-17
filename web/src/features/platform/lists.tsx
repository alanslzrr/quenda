import { localDateTime } from "../../app/dates";
import { Failure, Loading } from "../../app/feedback";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { Badge, type BadgeTone } from "../../ui/badge/badge";
import { RecordCard, RecordList } from "../../ui/record-card/record-card";
import { More } from "../municipal/shared";
import { staffOperations } from "../municipal/staff-model";
import { PlatformAccount } from "./account";
import { type Invitation, type Operator, statuses } from "./model";
import { platformView, usePlatformPages } from "./shared";

const invitationTones: Record<string, BadgeTone> = {
  PENDING: "info",
  ACCEPTED: "success",
  ACTIVE: "success",
  REVOKED: "danger",
  EXPIRED: "neutral",
  INVALIDATED: "neutral",
};

export function Operators() {
  const { t, locale } = usePreferences();
  const q = usePlatformPages<Operator>("operators");
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <Failure error={q.error} retry={() => void q.refetch()} />;
  const operators = q.data.pages.flatMap((p) => p.items);
  return (
    <>
      {!operators.length && (
        <p>
          {t(
            "No hay operadores en esta consulta.",
            "Non hai operadores nesta consulta.",
          )}
        </p>
      )}
      <RecordList>
        {operators.map((o) => (
          <RecordCard
            key={o.accountId}
            title={<PlatformAccount id={o.accountId} name={o.accountName} />}
            status={
              o.revokedAt ? (
                <Badge size="sm" tone="danger">
                  {t("Revocado", "Revogado")}
                </Badge>
              ) : o.active ? (
                <Badge size="sm" tone="success">
                  {t("Habilitado", "Habilitado")}
                </Badge>
              ) : (
                <Badge size="sm" tone="warning">
                  {t("No habilitado", "Non habilitado")}
                </Badge>
              )
            }
            details={[
              {
                label: t("Concesión", "Concesión"),
                value: localDateTime(o.grantedAt, locale),
              },
              ...(o.revokedAt
                ? [
                    {
                      label: t("Revocación", "Revogación"),
                      value: localDateTime(o.revokedAt, locale),
                    },
                  ]
                : []),
            ]}
            actions={
              !o.revokedAt && (
                <LinkButton
                  variant="danger"
                  size="sm"
                  to={`${platformView}/retirar-operador?id=${encodeURIComponent(o.accountId)}`}
                  state={{ name: o.accountName }}
                >
                  {t(
                    "Retirar permiso de operador",
                    "Retirar permiso de operador",
                  )}
                </LinkButton>
              )
            }
          />
        ))}
      </RecordList>
      <More query={q} />
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
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <Failure error={q.error} retry={() => void q.refetch()} />;
  const invitations = q.data.pages.flatMap((p) => p.items);
  return (
    <>
      {!invitations.length && (
        <p>
          {t(
            "No hay invitaciones en esta consulta.",
            "Non hai invitacións nesta consulta.",
          )}
        </p>
      )}
      <RecordList>
        {invitations.map((i) => (
          <RecordCard
            key={i.invitationId}
            title={<PlatformAccount id={i.accountId} name={i.accountName} />}
            status={
              <Badge size="sm" tone={invitationTones[i.status] ?? "neutral"}>
                {t(...(statuses[i.status] ?? [i.status, i.status]))}
              </Badge>
            }
            details={[
              {
                label: t("Invitación", "Invitación"),
                value: i.invitationId,
              },
              {
                label: t("Emisor", "Emisor"),
                value: (
                  <PlatformAccount id={i.invitedBy} name={i.invitedByName} />
                ),
              },
              {
                label: t("Aceptar antes de", "Aceptar antes de"),
                value: localDateTime(i.expiresAt, locale),
              },
              ...(privacy
                ? [
                    {
                      label: t("Permiso hasta", "Permiso ata"),
                      value: i.roleExpiresAt
                        ? localDateTime(i.roleExpiresAt, locale)
                        : t(
                            "Sin caducidad automática",
                            "Sen caducidade automática",
                          ),
                    },
                    {
                      label: t("Permisos", "Permisos"),
                      value: (i.permissions ?? [])
                        .map((p) => t(...staffOperations[p]))
                        .join(" · "),
                    },
                    { label: t("Motivo", "Motivo"), value: i.reason },
                  ]
                : []),
            ]}
            actions={
              (privacy
                ? ["PENDING", "ACTIVE"].includes(i.status)
                : ["PENDING", "EXPIRED"].includes(i.status)) && (
                <LinkButton
                  variant="danger"
                  size="sm"
                  to={`${platformView}/${privacy ? "retirar-privacidad" : "retirar-invitacion"}?id=${encodeURIComponent(i.invitationId)}`}
                  state={{ name: i.accountName ?? i.accountId }}
                >
                  {t("Revocar", "Revogar")}
                </LinkButton>
              )
            }
          />
        ))}
      </RecordList>
      <More query={q} />
    </>
  );
}
