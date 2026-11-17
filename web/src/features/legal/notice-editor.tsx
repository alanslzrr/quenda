import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { ActionForm, textField } from "../../app/action";
import { api } from "../../app/api";
import { DateField } from "../../app/date-fields";
import { Failure, Loading } from "../../app/feedback";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { Select } from "../../ui/select/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs/tabs";
import { Textarea } from "../../ui/textarea/textarea";
import styles from "../municipal/municipal.module.css";
import { ManagementPage } from "../municipal/page";
import { Denied, useMunicipality } from "../municipal/shared";
import { useNotice } from "./legal-page";
import editor from "./notice-editor.module.css";
import {
  type Conformance,
  conformanceLabel,
  kinds,
  kindTitle,
  type NoticeBody,
  type NoticeKind,
  noticeFields,
  noticePath,
} from "./notices";

const unset = "none-selected";
const statuses: Conformance[] = ["full", "partial", "none"];

function NoticeForm({
  kind,
  tenantId,
}: {
  kind: NoticeKind;
  tenantId?: string;
}) {
  const { locale, t } = usePreferences();
  const client = useQueryClient();
  const query = useNotice(kind, tenantId);
  const [known, setKnown] = useState<number>();
  const [status, setStatus] = useState<string | undefined>();
  if (query.isPending) return <Loading />;
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const notice = query.data;
  const version = known ?? notice.version;
  const lang = locale === "gl" ? 1 : 0;
  const currentStatus = status ?? notice.body.status ?? unset;
  const path = tenantId
    ? `/api/municipalities/${tenantId}/notices/${kind}`
    : `/api/platform/notices/${kind}`;
  return (
    <section className={styles.section} aria-labelledby={`notice-${kind}`}>
      <h2 id={`notice-${kind}`}>{kindTitle[kind][lang]}</h2>
      <p>
        {notice.version === 0
          ? t(
              "Todavía no hay una versión publicada. Al guardar se publica la versión 1.",
              "Aínda non hai unha versión publicada. Ao gardar publícase a versión 1.",
            )
          : t(
              `Versión publicada: ${notice.version}. Guardar publica una versión nueva y conserva las anteriores.`,
              `Versión publicada: ${notice.version}. Gardar publica unha versión nova e conserva as anteriores.`,
            )}
      </p>
      <LinkButton size="sm" to={noticePath(kind, tenantId)}>
        {t("Ver la página pública", "Ver a páxina pública")}
        <ArrowUpRight size={16} aria-hidden="true" />
      </LinkButton>
      {/* Its publish button is pinned to the bottom of the scroller (see notice-editor.module.css). */}
      <div className={editor.form} data-pinned-end="">
        <ActionForm
          label={t("Publicar texto", "Publicar texto")}
          success={t("Texto publicado.", "Texto publicado.")}
          resetOnSuccess={false}
          submit={async (data) => {
            const body: NoticeBody = { gl: {}, es: {} };
            for (const field of noticeFields[kind]) {
              const gl = textField(data, `gl.${field.key}`).trim();
              const es = textField(data, `es.${field.key}`).trim();
              if (gl && body.gl) body.gl[field.key] = gl;
              if (es && body.es) body.es[field.key] = es;
            }
            if (kind === "accessibility") {
              if (currentStatus !== unset)
                body.status = currentStatus as Conformance;
              const prepared = textField(data, "preparedOn");
              const reviewed = textField(data, "reviewedOn");
              if (prepared) body.preparedOn = prepared;
              if (reviewed) body.reviewedOn = reviewed;
            }
            const saved = await api<{ version: number }>(
              path,
              {
                method: "PUT",
                body: JSON.stringify({ expectedVersion: version, body }),
              },
              locale,
            );
            setKnown(saved.version);
            await client.invalidateQueries({
              queryKey: ["public", tenantId ?? "instance", "notice", kind],
            });
          }}
        >
          {kind === "accessibility" && (
            <>
              <Select
                label={t("Estado de conformidad", "Estado de conformidade")}
                value={currentStatus}
                onValueChange={setStatus}
                options={[
                  { value: unset, label: t("Sin indicar", "Sen indicar") },
                  ...statuses.map((value) => ({
                    value,
                    label: conformanceLabel[value][lang],
                  })),
                ]}
              />
              <DateField
                label={t("Fecha de preparación", "Data de preparación")}
                name="preparedOn"
                defaultValue={notice.body.preparedOn ?? ""}
              />
              <DateField
                label={t(
                  "Fecha de la última revisión",
                  "Data da última revisión",
                )}
                name="reviewedOn"
                defaultValue={notice.body.reviewedOn ?? ""}
              />
            </>
          )}
          {noticeFields[kind].map((field) => (
            <fieldset key={field.key} className={styles.fieldGroup}>
              <legend>{field.label[lang]}</legend>
              {field.hint && <p>{field.hint[lang]}</p>}
              {/* Both languages of one passage side by side, so a translation is written against its original. */}
              <div className={editor.bilingual}>
                <Textarea
                  label={t("En gallego", "En galego")}
                  name={`gl.${field.key}`}
                  maxLength={4000}
                  defaultValue={notice.body.gl?.[field.key] ?? ""}
                />
                <Textarea
                  label={t("En castellano", "En castelán")}
                  name={`es.${field.key}`}
                  maxLength={4000}
                  defaultValue={notice.body.es?.[field.key] ?? ""}
                />
              </div>
            </fieldset>
          ))}
        </ActionForm>
      </div>
    </section>
  );
}

function Editors({ tenantId }: { tenantId?: string }) {
  const { locale, t } = usePreferences();
  const lang = locale === "gl" ? 1 : 0;
  const [tab, setTab] = useState<NoticeKind>("privacy");
  return (
    <ManagementPage
      title={t("Textos legales", "Textos legais")}
      description={
        tenantId
          ? t(
              "Información que la ciudadanía ve en las páginas públicas de tu municipio. La plataforma aporta lo que hace la aplicación; tú indicas quién es el responsable y cómo contactarlo.",
              "Información que a cidadanía ve nas páxinas públicas do teu municipio. A plataforma achega o que fai a aplicación; ti indicas quen é o responsable e como contactalo.",
            )
          : t(
              "Textos de la instancia, que se muestran fuera de un municipio concreto.",
              "Textos da instancia, que se amosan fóra dun municipio concreto.",
            )
      }
    >
      <Tabs value={tab} onValueChange={(value) => setTab(value as NoticeKind)}>
        <TabsList aria-label={t("Tipo de texto", "Tipo de texto")}>
          {kinds.map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {kindTitle[kind][lang]}
            </TabsTrigger>
          ))}
        </TabsList>
        {kinds.map((kind) => (
          <TabsContent key={kind} value={kind} forceMount>
            <NoticeForm kind={kind} tenantId={tenantId} />
          </TabsContent>
        ))}
      </Tabs>
    </ManagementPage>
  );
}

/** Administrator view: the legal texts of the municipality being managed. */
export function MunicipalNotices() {
  const municipality = useMunicipality();
  if (!municipality.administrator) return <Denied />;
  return <Editors tenantId={municipality.id} />;
}
/** Operator view: the instance texts. The operator guard of the platform page already applies. */
export function InstanceNotices() {
  return <Editors />;
}
