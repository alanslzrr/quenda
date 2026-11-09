import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { storageEntries } from "../../app/storage-keys";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Alert } from "../../ui/alert/alert";
import { useMunicipality, usePublicAppearance } from "../catalog/municipality";
import { baseText } from "./base-text";
import styles from "./legal.module.css";
import {
  conformanceLabel,
  kindTitle,
  type NoticeKind,
  noticeApi,
  noticeFields,
  type PublicNotice,
  pick,
} from "./notices";

export function useNotice(kind: NoticeKind, tenantId?: string) {
  const { locale } = usePreferences();
  return useQuery({
    queryKey: ["public", tenantId ?? "instance", "notice", kind, locale],
    queryFn: ({ signal }) =>
      api<PublicNotice>(noticeApi(kind, tenantId), { signal }, locale),
  });
}

function MunicipalPage({
  kind,
  tenantId,
}: {
  kind: NoticeKind;
  tenantId: string;
}) {
  usePublicAppearance(tenantId);
  const municipality = useMunicipality(tenantId);
  return (
    <Content kind={kind} tenantId={tenantId} owner={municipality.data?.name} />
  );
}
function InstancePage({ kind }: { kind: NoticeKind }) {
  useMunicipalTheme(undefined);
  return <Content kind={kind} />;
}

/** Legal text of one municipality (route with a tenant) or of the instance. */
export function LegalPage({ kind }: { kind: NoticeKind }) {
  const { tenantId } = useParams();
  return tenantId ? (
    <MunicipalPage kind={kind} tenantId={tenantId} />
  ) : (
    <InstancePage kind={kind} />
  );
}

function Content({
  kind,
  tenantId,
  owner,
}: {
  kind: NoticeKind;
  tenantId?: string;
  owner?: string;
}) {
  const { locale, t } = usePreferences();
  const query = useNotice(kind, tenantId);
  const lang = locale === "gl" ? 1 : 0;
  if (query.isPending) return <Loading />;
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const notice = query.data;
  const fields = noticeFields[kind]
    .map((field) => ({ field, text: pick(notice.body, locale, field.key) }))
    .filter((item) => item.text);
  const published = notice.publishedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
        new Date(notice.publishedAt),
      )
    : undefined;
  return (
    <article className={styles.page}>
      <header>
        <h1 className={styles.title}>{kindTitle[kind][lang]}</h1>
        {owner && <p className={styles.owner}>{owner}</p>}
        {published && (
          <p className={styles.meta}>
            {t("Última actualización", "Última actualización")}: {published}
          </p>
        )}
      </header>
      {notice.version === 0 && (
        <Alert
          tone="info"
          title={t(
            "Texto pendiente de completar por la entidad responsable",
            "Texto pendente de completar pola entidade responsable",
          )}
        >
          <p>
            {t(
              "Todavía no se ha publicado el contenido propio de esta entidad. Mientras tanto se muestra lo que hace la aplicación.",
              "Aínda non se publicou o contido propio desta entidade. Mentres tanto amósase o que fai a aplicación.",
            )}
          </p>
        </Alert>
      )}
      {kind === "accessibility" && notice.body.status && (
        <section aria-labelledby="conformance">
          <h2 id="conformance">
            {t("Estado de conformidad", "Estado de conformidade")}
          </h2>
          <p>{conformanceLabel[notice.body.status][lang]}</p>
          {notice.body.preparedOn && (
            <p>
              {t("Declaración preparada el", "Declaración preparada o")}{" "}
              {notice.body.preparedOn}
              {notice.body.reviewedOn &&
                `. ${t("Última revisión", "Última revisión")}: ${notice.body.reviewedOn}`}
              .
            </p>
          )}
        </section>
      )}
      {fields.map(({ field, text }) => (
        <section key={field.key} aria-labelledby={`f-${field.key}`}>
          <h2 id={`f-${field.key}`}>{field.label[lang]}</h2>
          <p className={styles.text}>{text}</p>
        </section>
      ))}
      <section aria-labelledby="platform">
        <h2 id="platform">
          {kind === "privacy"
            ? t(
                "Qué hace la aplicación con tus datos",
                "Que fai a aplicación cos teus datos",
              )
            : t("Sobre la aplicación", "Sobre a aplicación")}
        </h2>
        <ul>
          {baseText[kind][locale].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      {kind === "privacy" && (
        <section aria-labelledby="storage">
          <h2 id="storage">
            {t(
              "Almacenamiento en tu navegador",
              "Almacenamento no teu navegador",
            )}
          </h2>
          <p>
            {t(
              "Solo se usa almacenamiento necesario para el funcionamiento, sin fines de seguimiento. La sesión se mantiene con una cookie propia, segura y no accesible desde scripts.",
              "Só se usa almacenamento necesario para o funcionamento, sen fins de seguimento. A sesión mantense cunha cookie propia, segura e non accesible desde scripts.",
            )}
          </p>
          <ul>
            {storageEntries.map((entry) => (
              <li key={entry.key}>
                <code>{entry.key}</code> (
                {entry.store === "local"
                  ? t("almacenamiento local", "almacenamento local")
                  : t(
                      "almacenamiento de la pestaña",
                      "almacenamento da lapela",
                    )}
                ): {entry.purpose[lang]} {entry.duration[lang]}.
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
