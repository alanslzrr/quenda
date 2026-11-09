export type NoticeKind = "privacy" | "legal" | "accessibility";
export type Locale = "es" | "gl";
export type Conformance = "full" | "partial" | "none";
export interface NoticeBody {
  gl?: Record<string, string>;
  es?: Record<string, string>;
  status?: Conformance;
  preparedOn?: string;
  reviewedOn?: string;
}
export interface PublicNotice {
  kind: NoticeKind;
  version: number;
  body: NoticeBody;
  publishedAt: string | null;
}
export const kinds: readonly NoticeKind[] = [
  "privacy",
  "legal",
  "accessibility",
];
export const kindSlug: Record<NoticeKind, string> = {
  privacy: "privacidad",
  legal: "aviso-legal",
  accessibility: "accesibilidad",
};
export const kindTitle: Record<NoticeKind, [string, string]> = {
  privacy: ["Información sobre privacidad", "Información sobre privacidade"],
  legal: ["Aviso legal", "Aviso legal"],
  accessibility: [
    "Declaración de accesibilidad",
    "Declaración de accesibilidade",
  ],
};
export const kindShort: Record<NoticeKind, [string, string]> = {
  privacy: ["Privacidad", "Privacidade"],
  legal: ["Aviso legal", "Aviso legal"],
  accessibility: ["Accesibilidad", "Accesibilidade"],
};
export interface NoticeField {
  key: string;
  label: [es: string, gl: string];
  hint?: [es: string, gl: string];
}
export const noticeFields: Record<NoticeKind, readonly NoticeField[]> = {
  privacy: [
    {
      key: "controller",
      label: ["Responsable del tratamiento", "Responsable do tratamento"],
    },
    {
      key: "controllerContact",
      label: ["Contacto del responsable", "Contacto do responsable"],
    },
    {
      key: "dpo",
      label: [
        "Delegado de protección de datos",
        "Delegado de protección de datos",
      ],
    },
    { key: "purposes", label: ["Finalidades", "Finalidades"] },
    { key: "legalBasis", label: ["Base jurídica", "Base xurídica"] },
    { key: "recipients", label: ["Destinatarios", "Destinatarios"] },
    {
      key: "retention",
      label: ["Plazos de conservación", "Prazos de conservación"],
    },
    {
      key: "rights",
      label: ["Ejercicio de derechos", "Exercicio de dereitos"],
    },
    {
      key: "complaint",
      label: [
        "Reclamación ante la autoridad de control",
        "Reclamación ante a autoridade de control",
      ],
      hint: [
        "Por ejemplo: Agencia Española de Protección de Datos (www.aepd.es).",
        "Por exemplo: Axencia Española de Protección de Datos (www.aepd.es).",
      ],
    },
  ],
  legal: [
    { key: "entity", label: ["Denominación", "Denominación"] },
    { key: "taxId", label: ["NIF", "NIF"] },
    { key: "address", label: ["Domicilio", "Domicilio"] },
    { key: "contact", label: ["Contacto", "Contacto"] },
    { key: "notes", label: ["Otras indicaciones", "Outras indicacións"] },
  ],
  accessibility: [
    {
      key: "nonAccessible",
      label: ["Contenido no accesible", "Contido non accesible"],
    },
    {
      key: "evaluation",
      label: ["Método de evaluación", "Método de avaliación"],
    },
    {
      key: "feedback",
      label: [
        "Comunicar un problema de accesibilidad",
        "Comunicar un problema de accesibilidade",
      ],
      hint: [
        "Un medio de contacto al que la ciudadanía pueda escribir.",
        "Un medio de contacto ao que a cidadanía poida escribir.",
      ],
    },
    {
      key: "enforcement",
      label: ["Procedimiento de reclamación", "Procedemento de reclamación"],
    },
  ],
};
export const conformanceLabel: Record<Conformance, [string, string]> = {
  full: [
    "Totalmente conforme con WCAG 2.1 nivel AA",
    "Totalmente conforme con WCAG 2.1 nivel AA",
  ],
  partial: [
    "Parcialmente conforme con WCAG 2.1 nivel AA",
    "Parcialmente conforme con WCAG 2.1 nivel AA",
  ],
  none: [
    "No conforme con WCAG 2.1 nivel AA",
    "Non conforme con WCAG 2.1 nivel AA",
  ],
};

/** The text in the active language, or in the other co-official one when only that was written. */
export function pick(body: NoticeBody, locale: Locale, field: string) {
  const other = locale === "gl" ? "es" : "gl";
  return (
    body[locale]?.[field]?.trim() || body[other]?.[field]?.trim() || undefined
  );
}
export function noticePath(kind: NoticeKind, tenantId?: string) {
  return `${tenantId ? `/municipios/${tenantId}` : ""}/${kindSlug[kind]}`;
}
export function noticeApi(kind: NoticeKind, tenantId?: string) {
  return tenantId
    ? `/api/public/municipalities/${tenantId}/notices/${kind}`
    : `/api/public/notices/${kind}`;
}
