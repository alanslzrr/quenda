import { Failure, Loading } from "../../app/feedback";
import { ActionLink as Link } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import styles from "../municipal/municipal.module.css";
import { usePrivacyQuery, usePrivacyScope } from "./context";
import {
  type Category,
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
      {q.data.policies.map((p) => (
        <section className={styles.section} key={p.policyId}>
          <h3>
            <Family value={p.category} />
          </h3>
          <p>
            {p.revokedAt
              ? t("Retirada", "Retirada")
              : p.supersededAt
                ? t("Sustituida", "Substituída")
                : t("Activa", "Activa")}{" "}
            ·{" "}
            {p.action === "BLOCK"
              ? t("Bloqueo", "Bloqueo")
              : t("Supresión", "Supresión")}{" "}
            · {p.retentionDays} {t("días", "días")}
          </p>
          <p>{p.policyId}</p>
          <dl>
            {[
              [t("Finalidad", "Finalidade"), p.purpose],
              [t("Responsable", "Responsable"), p.controllerReference],
              [t("Aprobación", "Aprobación"), p.approvalReference],
              [t("Motivo", "Motivo"), p.reason],
              [
                t("Registro", "Rexistro"),
                new Date(p.approvedAt).toLocaleString(locale),
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>
                  <strong>{label}</strong>
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {p.blockDays !== null && (
            <p>
              {t("Archivo restringido", "Arquivo restrinxido")}: {p.blockDays}{" "}
              {t("días", "días")}
            </p>
          )}
          {s.execute && !p.revokedAt && !p.supersededAt && (
            <Link to={`${s.view}/retirar?id=${p.policyId}`}>
              {t("Retirar política", "Retirar política")}
            </Link>
          )}
        </section>
      ))}
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
      {q.data.holds.map((h) => (
        <section className={styles.section} key={h.holdId}>
          <h3>
            <Family value={h.category} />
          </h3>
          <p>
            {t("Excepción", "Excepción")}: {h.holdId}
          </p>
          <p>
            {h.subjectId
              ? t("Interesado", "Interesado")
              : t("Registro", "Rexistro")}
            : {h.subjectId ?? h.targetKey}
          </p>
          <p>{h.reason}</p>
          <p>
            {t("Autorización", "Autorización")}: {h.authorizationReference}
          </p>
          <p>{new Date(h.createdAt).toLocaleString(locale)}</p>
          {s.execute && (
            <Link to={`${s.view}/levantar?id=${h.holdId}`}>
              {t("Levantar excepción", "Levantar excepción")}
            </Link>
          )}
        </section>
      ))}
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
      {q.data.conflicts.map((c) => (
        <section
          className={styles.section}
          key={`${c.policyId}:${c.category}:${c.targetKey}`}
        >
          <h3>
            <Family value={c.category} />
          </h3>
          <p>
            {t("Política", "Política")}: {c.policyId}
          </p>
          <p>
            {t("Registro", "Rexistro")}: {c.targetKey}
          </p>
          <p>{c.reason}</p>
          <p>{new Date(c.lastSeenAt).toLocaleString(locale)}</p>
        </section>
      ))}
    </>
  );
}
