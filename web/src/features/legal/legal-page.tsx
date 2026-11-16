import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { api } from "../../app/api";
import { useMunicipality, usePublicAppearance } from "../../app/branding";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { storageEntries } from "../../app/storage-keys";
import { useMunicipalTheme } from "../../app/theme-provider";
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
import { accessibilityText, legalText, privacyText } from "./standard-text";

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

/** "On this page": the section titles as links, read from the rendered text so it never drifts from it. */
function Contents({ of }: { of: React.RefObject<HTMLElement | null> }) {
  const { t } = usePreferences();
  const [items, setItems] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    const headings =
      of.current?.querySelectorAll<HTMLElement>("section > h2[id]");
    setItems(
      Array.from(headings ?? []).map((h) => ({
        id: h.id,
        title: h.textContent ?? "",
      })),
    );
  }, [of]);
  if (items.length < 3) return null;
  return (
    <nav
      className={styles.contents}
      aria-label={t("En esta página", "Nesta páxina")}
    >
      <p className={styles.contentsTitle}>
        {t("En esta página", "Nesta páxina")}
      </p>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <a href={`#${item.id}`}>{item.title}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/** A paragraph from the entity's published text, or the standard wording when it has none. */
function Paragraph({
  published,
  standard,
}: {
  published?: string;
  standard: string;
}) {
  return <p className={styles.text}>{published ?? standard}</p>;
}

/** Labelled facts the entity published; nothing is rendered for missing ones. */
function Facts({ items }: { items: { label: string; value?: string }[] }) {
  const present = items.filter((item) => item.value);
  if (!present.length) return null;
  return (
    <dl className={styles.facts}>
      {present.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd className={styles.text}>{item.value}</dd>
        </div>
      ))}
    </dl>
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
  const article = useRef<HTMLElement>(null);
  const lang = locale === "gl" ? 1 : 0;
  if (query.isPending) return <Loading />;
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const notice = query.data;
  const field = (key: string) => pick(notice.body, locale, key);
  const label = (key: string) =>
    noticeFields[kind].find((item) => item.key === key)?.label[lang] ?? key;
  const published = notice.publishedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
        new Date(notice.publishedAt),
      )
    : undefined;
  return (
    <article className={styles.page} ref={article}>
      <header>
        <h1 className={styles.title}>{kindTitle[kind][lang]}</h1>
        {owner && <p className={styles.owner}>{owner}</p>}
        {published && (
          <p className={styles.meta}>
            {t("Última actualización", "Última actualización")}: {published}
          </p>
        )}
      </header>
      <Contents of={article} />
      {kind === "privacy" && (
        <Privacy field={field} label={label} lang={lang} />
      )}
      {kind === "legal" && <Legal field={field} label={label} lang={lang} />}
      {kind === "accessibility" && (
        <Accessibility
          field={field}
          lang={lang}
          owner={owner}
          notice={notice}
        />
      )}
    </article>
  );
}

interface PartProps {
  field: (key: string) => string | undefined;
  lang: 0 | 1;
}

function Privacy({
  field,
  label,
  lang,
}: PartProps & { label: (key: string) => string }) {
  const { t } = usePreferences();
  const controller = ["controller", "controllerContact", "dpo"].map((key) => ({
    label: label(key),
    value: field(key),
  }));
  return (
    <>
      {controller.some((item) => item.value) && (
        <Section id="controller" title={label("controller")}>
          <Facts items={controller} />
        </Section>
      )}
      <Section id="data" title={t("Qué datos tratamos", "Que datos tratamos")}>
        <ul>
          {privacyText.data.map((line) => (
            <li key={line[0]}>{line[lang]}</li>
          ))}
        </ul>
      </Section>
      <Section id="purposes" title={label("purposes")}>
        <Paragraph
          published={field("purposes")}
          standard={privacyText.purposes[lang]}
        />
      </Section>
      <Section id="legal-basis" title={label("legalBasis")}>
        <Paragraph
          published={field("legalBasis")}
          standard={privacyText.legalBasis[lang]}
        />
      </Section>
      <Section id="recipients" title={label("recipients")}>
        <Paragraph
          published={field("recipients")}
          standard={privacyText.recipients[lang]}
        />
      </Section>
      <Section id="retention" title={label("retention")}>
        <Paragraph
          published={field("retention")}
          standard={privacyText.retention[lang]}
        />
      </Section>
      <Section id="rights" title={label("rights")}>
        <Paragraph
          published={field("rights")}
          standard={privacyText.rights[lang]}
        />
      </Section>
      <Section id="complaint" title={label("complaint")}>
        <Paragraph
          published={field("complaint")}
          standard={privacyText.complaint[lang]}
        />
      </Section>
      <Section
        id="storage"
        title={t(
          "Almacenamiento en tu navegador",
          "Almacenamento no teu navegador",
        )}
      >
        <p>{privacyText.storage[lang]}</p>
        <ul>
          {storageEntries.map((entry) => (
            <li key={entry.key}>
              <code>{entry.key}</code> (
              {entry.store === "local"
                ? t("almacenamiento local", "almacenamento local")
                : t("almacenamiento de la pestaña", "almacenamento da lapela")}
              ): {entry.purpose[lang]} {entry.duration[lang]}.
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function Legal({
  field,
  label,
  lang,
}: PartProps & { label: (key: string) => string }) {
  const { t } = usePreferences();
  const holder = ["entity", "taxId", "address", "contact"].map((key) => ({
    label: label(key),
    value: field(key),
  }));
  return (
    <>
      {holder.some((item) => item.value) && (
        <Section id="holder" title={t("Titular del sitio", "Titular do sitio")}>
          <Facts items={holder} />
        </Section>
      )}
      <Section id="purpose" title={t("Objeto", "Obxecto")}>
        <p>{legalText.purpose[lang]}</p>
      </Section>
      <Section id="terms" title={t("Condiciones de uso", "Condicións de uso")}>
        <p>{legalText.terms[lang]}</p>
      </Section>
      <Section id="liability" title={t("Responsabilidad", "Responsabilidade")}>
        <p>{legalText.liability[lang]}</p>
      </Section>
      <Section
        id="property"
        title={t("Propiedad intelectual", "Propiedade intelectual")}
      >
        <p>{legalText.property[lang]}</p>
        <p>
          <a href="/legal/source">{legalText.source[lang]}</a>
        </p>
      </Section>
      {field("notes") && (
        <Section id="notes" title={label("notes")}>
          <p className={styles.text}>{field("notes")}</p>
        </Section>
      )}
      <Section
        id="law"
        title={t("Legislación aplicable", "Lexislación aplicable")}
      >
        <p>{legalText.law[lang]}</p>
      </Section>
    </>
  );
}

function Accessibility({
  field,
  lang,
  owner,
  notice,
}: PartProps & { owner?: string; notice: PublicNotice }) {
  const { t } = usePreferences();
  const { status, preparedOn, reviewedOn } = notice.body;
  return (
    <>
      <p>{accessibilityText.commitment(owner)[lang]}</p>
      {status && (
        <Section
          id="conformance"
          title={t("Situación de cumplimiento", "Situación de cumprimento")}
        >
          <p>{conformanceLabel[status][lang]}</p>
        </Section>
      )}
      {field("nonAccessible") && (
        <Section
          id="non-accessible"
          title={t("Contenido no accesible", "Contido non accesible")}
        >
          <p className={styles.text}>{field("nonAccessible")}</p>
        </Section>
      )}
      <Section
        id="preparation"
        title={t(
          "Preparación de esta declaración",
          "Preparación desta declaración",
        )}
      >
        {preparedOn && (
          <p>
            {t("Declaración preparada el", "Declaración preparada o")}{" "}
            {preparedOn}
            {reviewedOn &&
              `. ${t("Última revisión", "Última revisión")}: ${reviewedOn}`}
            .
          </p>
        )}
        {field("evaluation") && (
          <p className={styles.text}>{field("evaluation")}</p>
        )}
        <ul>
          {accessibilityText.design.map((line) => (
            <li key={line[0]}>{line[lang]}</li>
          ))}
        </ul>
      </Section>
      <Section
        id="feedback"
        title={t(
          "Observaciones y datos de contacto",
          "Observacións e datos de contacto",
        )}
      >
        <Paragraph
          published={field("feedback")}
          standard={accessibilityText.feedback[lang]}
        />
      </Section>
      <Section
        id="enforcement"
        title={t("Procedimiento de aplicación", "Procedemento de aplicación")}
      >
        <Paragraph
          published={field("enforcement")}
          standard={accessibilityText.enforcement[lang]}
        />
      </Section>
    </>
  );
}
