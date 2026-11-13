import { useParams } from "react-router";
import { textField } from "../../app/action";
import { Failure, Loading } from "../../app/feedback";
import { ActionLink as Link } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { blocksEditor, EditorRecovery } from "../../app/read-recovery";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { SortableDataTable } from "../../ui/sortable-data-table/sortable-data-table";
import styles from "../municipal/municipal.module.css";
import {
  Denied,
  endpoint,
  More,
  Reason,
  useMunicipality,
  useMunicipalPages,
  useMunicipalQuery,
} from "../municipal/shared";
import { dateTime, PendingLink } from "../reservations/shared";
import { CollaborationAction } from "./action";
import ui from "./collaboration.module.css";
import { AgreementEditor } from "./editor";
import { type Agreement, type AgreementSummary, agreementPath } from "./model";

export function Agreements() {
  const m = useMunicipality();
  return m.administrator ? <AgreementList /> : <Denied />;
}
function AgreementList() {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const query = useMunicipalPages<AgreementSummary>(
    `${endpoint(m.id)}/agreements`,
  );
  return (
    <div className={ui.surface}>
      <h1>{t("Convenios intermunicipales", "Convenios intermunicipais")}</h1>
      <div className={ui.actions}>
        <Link to={`${agreementPath(m.id)}/nuevo`}>
          {t("Nuevo convenio", "Novo convenio")}
        </Link>
        <Link to={`/administracion/${m.id}/acreditaciones`} danger>
          {t("Revocar acreditación", "Revogar acreditación")}
        </Link>
      </div>
      <PendingLink />
      <p>
        {t(
          "Se muestran versiones en las que participa este municipio. El estado registrado no identifica por sí solo la versión efectiva.",
          "Amósanse versións nas que participa este municipio. O estado rexistrado non identifica por si só a versión efectiva.",
        )}
      </p>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <SortableDataTable
            rows={query.data.pages
              .flatMap((p) => p.items)
              .map((p) => ({ ...p, key: `${p.agreementId}:${p.version}` }))}
            rowKey="key"
            caption={t("Versiones del convenio", "Versións do convenio")}
            emptyMessage={t(
              "No hay versiones visibles.",
              "Non hai versións visibles.",
            )}
            columns={[
              {
                key: "name",
                label: t("Convenio", "Convenio"),
                sortable: false,
                render: (_, r) => (
                  <Link to={agreementPath(m.id, r.agreementId, r.version)}>
                    {r.name} · {t("versión", "versión")} {r.version}
                  </Link>
                ),
              },
              {
                key: "status",
                label: t("Estado registrado", "Estado rexistrado"),
                sortable: false,
              },
              {
                key: "startsAt",
                label: t("Vigencia acordada", "Vixencia acordada"),
                sortable: false,
                render: (_, r) => (
                  <>
                    {dateTime(r.startsAt, r.timeZone, locale)} —{" "}
                    {dateTime(r.endsAt, r.timeZone, locale)}
                  </>
                ),
              },
            ]}
          />
          <More query={query} />
        </>
      )}
    </div>
  );
}
export function NewAgreement() {
  const m = useMunicipality();
  return m.administrator ? <AgreementEditor /> : <Denied />;
}
export function AgreementPage({ edit = false }: { edit?: boolean }) {
  const m = useMunicipality();
  return m.administrator ? <VersionPage edit={edit} /> : <Denied />;
}
export function useAgreement() {
  const m = useMunicipality();
  const { agreementId = "", version = "" } = useParams();
  return useMunicipalQuery<Agreement>(
    `${endpoint(m.id)}/agreements/${agreementId}/versions/${version}`,
  );
}
function VersionPage({ edit }: { edit: boolean }) {
  const query = useAgreement();
  if (query.isPending) return <Loading />;
  if (blocksEditor(query) || !query.data)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  return edit ? (
    <EditorRecovery
      error={query.isError ? query.error : null}
      retry={() => void query.refetch()}
    >
      <AgreementEditor
        key={`${query.data.agreementId}:${query.data.version}`}
        original={query.data}
      />
    </EditorRecovery>
  ) : (
    <VersionDetails item={query.data} />
  );
}
function VersionDetails({ item: a }: { item: Agreement }) {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const own = a.participants.find((p) => p.tenantId === m.id);
  const approved = a.approvals.some((p) => p.tenantId === m.id);
  const path = `${endpoint(m.id)}/agreements/${a.agreementId}`;
  const view = agreementPath(m.id, a.agreementId, a.version);
  return (
    <div className={ui.surface}>
      <Link to={agreementPath(m.id)}>
        {t("Versiones del convenio", "Versións do convenio")}
      </Link>
      <h1>
        {a.name} · {t("versión", "versión")} {a.version}
      </h1>
      <p>
        {t("Estado registrado", "Estado rexistrado")}:{" "}
        <strong>{a.status}</strong>
      </p>
      <p>
        {dateTime(a.startsAt, a.timeZone, locale)} —{" "}
        {dateTime(a.endsAt, a.timeZone, locale)}
        <br />
        {a.timeZone}
      </p>
      <p className={styles.notice}>
        {t(
          "La activación requiere todas las aprobaciones y las revisiones aplicables. La vigencia efectiva se comprueba en cada operación; una versión sustituida o vencida no habilita acceso.",
          "A activación require todas as aprobacións e as revisións aplicables. A vixencia efectiva compróbase en cada operación; unha versión substituída ou vencida non habilita acceso.",
        )}
      </p>
      <PendingLink />
      {a.aggregateReports && (
        <Link
          to={`/administracion/${m.id}/informes/revision?convenio=${encodeURIComponent(a.agreementId)}`}
        >
          {t(
            "Revisar privacidad de informes",
            "Revisar privacidade de informes",
          )}
        </Link>
      )}
      <dl>
        {[
          [t("Finalidad", "Finalidade"), a.purpose],
          [t("Base jurídica", "Base xurídica"), a.legalBasis],
          [t("Responsabilidades", "Responsabilidades"), a.responsibilities],
          [
            t("Conservación acordada", "Conservación acordada"),
            a.retentionPolicy,
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>
              <strong>{label}</strong>
            </dt>
            <dd className={ui.text}>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        {a.eligibility === "acceso_abierto"
          ? t(
              "Acceso abierto dentro del convenio vigente.",
              "Acceso aberto dentro do convenio vixente.",
            )
          : t(
              "Requiere acreditación vigente durante toda la reserva.",
              "Require acreditación vixente durante toda a reserva.",
            )}
      </p>
      <p>
        {a.weeklyLimit === null
          ? t("Sin cuota conjunta.", "Sen cota conxunta.")
          : `${t("Máximo de reservas por cuenta y semana", "Máximo de reservas por conta e semana")}: ${a.weeklyLimit}`}
      </p>
      <p>
        {a.aggregateReports
          ? t(
              "Capacidad de informes agregados habilitada en esta configuración.",
              "Capacidade de informes agregados habilitada nesta configuración.",
            )
          : t("Sin informes agregados.", "Sen informes agregados.")}
      </p>
      {a.legalReviewReference && (
        <p>
          {t("Revisión jurídica", "Revisión xurídica")}:{" "}
          {a.legalReviewReference}
        </p>
      )}
      {a.reportReviewReference && (
        <p>
          {t("Revisión de riesgo de informes", "Revisión de risco de informes")}
          : {a.reportReviewReference}
        </p>
      )}
      <h2>
        {t("Participantes y aprobaciones", "Participantes e aprobacións")}
      </h2>
      {a.participants.map((p) => {
        const approval = a.approvals.find((x) => x.tenantId === p.tenantId);
        return (
          <section className={styles.section} key={p.tenantId}>
            <h3>{p.tenantId === m.id ? m.name : p.tenantId}</h3>
            <p>
              {p.accreditationIssuer
                ? t("Emisor de acreditaciones", "Emisor de acreditacións")
                : t("No emite acreditaciones", "Non emite acreditacións")}
            </p>
            <ul>
              {p.unitIds.map((id) => (
                <li key={id}>
                  {id}
                  {p.tenantId === m.id && (
                    <>
                      {" "}
                      ·{" "}
                      <Link
                        to={`${agreementPath(m.id)}/unidades/${id}/reapertura`}
                      >
                        {t("Consultar vinculación", "Consultar vinculación")}
                      </Link>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {!p.unitIds.length && (
              <p>{t("Sin unidades adscritas.", "Sen unidades adscritas.")}</p>
            )}
            <p>
              {approval
                ? `${approval.approvedBy ? `${t("Aprobada por", "Aprobada por")} ${approval.approvedBy}` : t("Aprobada", "Aprobada")} · ${new Date(approval.approvedAt).toLocaleString(locale)}`
                : t("Sin aprobación registrada.", "Sen aprobación rexistrada.")}
            </p>
          </section>
        );
      })}
      <div className={ui.actions}>
        <Link to={`${view}/nueva-version`}>
          {t("Crear nueva versión", "Crear nova versión")}
        </Link>
        {own?.accreditationIssuer &&
          a.eligibility === "acreditacion_vigente" &&
          a.status === "ACTIVADO" && (
            <Link to={`${view}/acreditar`}>
              {t("Emitir acreditación", "Emitir acreditación")}
            </Link>
          )}
      </div>
      {a.status === "BORRADOR" && !approved && own && (
        <section className={styles.section}>
          <h2>{t("Aprobar participación", "Aprobar participación")}</h2>
          <CollaborationAction
            path={`${path}/approve`}
            label={t("Aprobar versión", "Aprobar versión")}
            body={() => ({ version: a.version, unitIds: own.unitIds })}
          >
            <p>
              {t(
                "La aprobación comprende esta versión y el conjunto exacto de unidades de tu municipio. No activa el convenio.",
                "A aprobación comprende esta versión e o conxunto exacto de unidades do teu municipio. Non activa o convenio.",
              )}
            </p>
            <Checkbox
              required
              label={t(
                "Confirmo esta versión y mis unidades",
                "Confirmo esta versión e as miñas unidades",
              )}
            />
          </CollaborationAction>
        </section>
      )}
      {a.status === "APROBADO" && (
        <section className={styles.section}>
          <h2>{t("Activar convenio", "Activar convenio")}</h2>
          <CollaborationAction
            path={`${path}/activate`}
            label={t("Activar versión", "Activar versión")}
            body={(d) => ({
              version: a.version,
              legalReviewReference: textField(d, "legalReviewReference").trim(),
              reportReviewReference: a.aggregateReports
                ? textField(d, "reportReviewReference").trim()
                : null,
            })}
          >
            <p>
              {t(
                "La activación concilia las reservas existentes sin cancelarlas ni reiniciar la cuota. Las referencias identifican revisiones realizadas, no las sustituyen.",
                "A activación concilia as reservas existentes sen cancelalas nin reiniciar a cota. As referencias identifican revisións realizadas, non as substitúen.",
              )}
            </p>
            <Input
              required
              name="legalReviewReference"
              maxLength={500}
              label={t(
                "Referencia de revisión jurídica",
                "Referencia de revisión xurídica",
              )}
            />
            {a.aggregateReports && (
              <Input
                required
                name="reportReviewReference"
                maxLength={500}
                label={t(
                  "Referencia de revisión de riesgo",
                  "Referencia de revisión de risco",
                )}
              />
            )}
            <Checkbox
              required
              label={t(
                "Confirmo la activación de esta versión",
                "Confirmo a activación desta versión",
              )}
            />
          </CollaborationAction>
        </section>
      )}
      {a.status === "ACTIVADO" && (
        <section className={styles.section}>
          <h2>{t("Suspender convenio", "Suspender convenio")}</h2>
          <CollaborationAction
            path={`${path}/suspend`}
            danger
            label={t("Suspender convenio", "Suspender convenio")}
            body={(d) => ({
              version: a.version,
              reason: textField(d, "reason").trim(),
            })}
          >
            <p>
              {t(
                "Afecta a todo el convenio: impide nuevas reservas y reprogramaciones, conserva las confirmadas y no reabre las unidades al público.",
                "Afecta a todo o convenio: impide novas reservas e reprogramacións, conserva as confirmadas e non reabre as unidades ao público.",
              )}
            </p>
            <Reason />
            <Checkbox
              required
              label={t(
                "Confirmo la suspensión del convenio",
                "Confirmo a suspensión do convenio",
              )}
            />
          </CollaborationAction>
        </section>
      )}
      {a.status === "SUSPENDIDO" && (
        <p>
          {t(
            "Para reactivar, crea una nueva versión y solicita sus aprobaciones y activación.",
            "Para reactivar, crea unha nova versión e solicita as súas aprobacións e activación.",
          )}
        </p>
      )}
    </div>
  );
}
