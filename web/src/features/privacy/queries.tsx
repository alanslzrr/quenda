import { localDateTime } from "../../app/dates";
import { Failure, Loading } from "../../app/feedback";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { Badge } from "../../ui/badge/badge";
import { RecordCard, RecordList } from "../../ui/record-card/record-card";
import { usePrivacyQuery, usePrivacyScope } from "./context";
import {
  type Category,
  conflictReason,
  families,
  type Policy,
  type RetentionStatus,
} from "./model";

function Family({ value }: { value: Category }) {
  const { locale } = usePreferences();
  return <>{families.find((f) => f.value === value)?.[locale] ?? value}</>;
}
export function Policies() {
  const s = usePrivacyScope();
  const { t, locale } = usePreferences();
  const q = usePrivacyQuery<{ policies: Policy[]; hasMore: boolean }>(
    "retention-policies",
  );
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <Failure error={q.error} retry={() => void q.refetch()} />;
  return (
    <>
      <h2>{t("Políticas de conservación", "Políticas de conservación")}</h2>
      {!q.data.policies.length && (
        <p>
          {t("No hay políticas registradas.", "Non hai políticas rexistradas.")}
        </p>
      )}
      {q.data.hasMore && (
        <p role="status">
          {t(
            "Se muestran hasta 100 políticas. La consulta no incluye todo el historial; solicita una revisión administrativa si necesitas otras referencias.",
            "Amósanse ata 100 políticas. A consulta non inclúe todo o historial; solicita unha revisión administrativa se precisas outras referencias.",
          )}
        </p>
      )}
      <RecordList>
        {q.data.policies.map((p) => (
          <RecordCard
            key={p.policyId}
            title={<Family value={p.category} />}
            status={
              p.revokedAt ? (
                <Badge size="sm" tone="danger">
                  {t("Retirada", "Retirada")}
                </Badge>
              ) : p.supersededAt ? (
                <Badge size="sm">{t("Sustituida", "Substituída")}</Badge>
              ) : (
                <Badge size="sm" tone="success">
                  {t("Activa", "Activa")}
                </Badge>
              )
            }
            details={[
              {
                label: t("Actuación", "Actuación"),
                value: `${p.action === "BLOCK" ? t("Bloqueo", "Bloqueo") : t("Supresión", "Supresión")} · ${p.retentionDays} ${t("días", "días")}`,
              },
              ...(p.blockDays !== null
                ? [
                    {
                      label: t("Archivo restringido", "Arquivo restrinxido"),
                      value: `${p.blockDays} ${t("días", "días")}`,
                    },
                  ]
                : []),
              { label: t("Política", "Política"), value: p.policyId },
              { label: t("Finalidad", "Finalidade"), value: p.purpose },
              {
                label: t("Responsable", "Responsable"),
                value: p.controllerReference,
              },
              {
                label: t("Aprobación", "Aprobación"),
                value: p.approvalReference,
              },
              { label: t("Motivo", "Motivo"), value: p.reason },
              {
                label: t("Registro", "Rexistro"),
                value: localDateTime(p.approvedAt, locale),
              },
            ]}
            actions={
              s.execute &&
              !p.revokedAt &&
              !p.supersededAt && (
                <LinkButton
                  variant="danger"
                  size="sm"
                  to={`${s.view}/retirar?id=${p.policyId}`}
                >
                  {t("Retirar política", "Retirar política")}
                </LinkButton>
              )
            }
          />
        ))}
      </RecordList>
    </>
  );
}
export function RetentionOverview() {
  const s = usePrivacyScope();
  const { t, locale } = usePreferences();
  const q = usePrivacyQuery<RetentionStatus>("retention-status");
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <Failure error={q.error} retry={() => void q.refetch()} />;
  return (
    <>
      <h2>{t("Excepciones activas", "Excepcións activas")}</h2>
      {q.data.hasMoreHolds && (
        <p role="status">
          {t(
            "La consulta está limitada a 100 excepciones; existen más registros.",
            "A consulta está limitada a 100 excepcións; existen máis rexistros.",
          )}
        </p>
      )}
      {!q.data.holds.length && (
        <p>
          {t(
            "No hay excepciones activas en esta consulta.",
            "Non hai excepcións activas nesta consulta.",
          )}
        </p>
      )}
      <RecordList>
        {q.data.holds.map((h) => (
          <RecordCard
            key={h.holdId}
            title={<Family value={h.category} />}
            details={[
              { label: t("Excepción", "Excepción"), value: h.holdId },
              {
                label: h.subjectId
                  ? t("Interesado", "Interesado")
                  : t("Registro", "Rexistro"),
                value: h.subjectId ?? h.targetKey,
              },
              {
                label: t("Autorización", "Autorización"),
                value: h.authorizationReference,
              },
              {
                label: t("Alta", "Alta"),
                value: localDateTime(h.createdAt, locale),
              },
              { label: t("Motivo", "Motivo"), value: h.reason },
            ]}
            actions={
              s.execute && (
                <LinkButton size="sm" to={`${s.view}/levantar?id=${h.holdId}`}>
                  {t("Levantar excepción", "Levantar excepción")}
                </LinkButton>
              )
            }
          />
        ))}
      </RecordList>
      <h2>{t("Conflictos de conservación", "Conflitos de conservación")}</h2>
      {q.data.hasMoreConflicts && (
        <p role="status">
          {t(
            "La consulta está limitada a 100 conflictos; existen más registros.",
            "A consulta está limitada a 100 conflitos; existen máis rexistros.",
          )}
        </p>
      )}
      {!q.data.conflicts.length && (
        <p>
          {t(
            "No hay conflictos en esta consulta.",
            "Non hai conflitos nesta consulta.",
          )}
        </p>
      )}
      <RecordList>
        {q.data.conflicts.map((c) => (
          <RecordCard
            key={`${c.policyId}:${c.category}:${c.targetKey}`}
            title={<Family value={c.category} />}
            details={[
              { label: t("Política", "Política"), value: c.policyId },
              { label: t("Registro", "Rexistro"), value: c.targetKey },
              {
                label: t("Última detección", "Última detección"),
                value: localDateTime(c.lastSeenAt, locale),
              },
              {
                label: t("Motivo", "Motivo"),
                value: conflictReason(c.reason, locale),
              },
            ]}
          />
        ))}
      </RecordList>
    </>
  );
}
