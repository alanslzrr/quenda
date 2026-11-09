export type Locale = "es" | "gl";
export interface Localized {
  gl?: string;
  es?: string;
}
export const unitKinds = [
  "polideportiva",
  "pabellon",
  "futbol",
  "tenis",
  "padel",
  "piscina",
  "sala",
  "gimnasio",
  "atletismo",
  "otro",
] as const;
export type UnitKind = (typeof unitKinds)[number];
export interface FacilityProfile {
  address?: string;
  postalCode?: string;
  location?: { latitude: number; longitude: number };
  description?: Localized;
  accessibility?: Localized;
  contact?: { phone?: string; email?: string };
}
export interface UnitProfile {
  kind?: UnitKind;
  indoor?: boolean;
  capacity?: number;
  description?: Localized;
}

/** The text in the active language, or in the other co-official one when the municipality wrote only that. */
export function localized(value: Localized | undefined, locale: Locale) {
  const other = locale === "gl" ? "es" : "gl";
  return value?.[locale]?.trim() || value?.[other]?.trim() || undefined;
}

export function addressLine(profile: FacilityProfile | undefined) {
  if (!profile) return undefined;
  const line = [profile.address, profile.postalCode].filter(Boolean).join(", ");
  return line || undefined;
}

/** A plain link, so no map tiles or third-party scripts are loaded just by viewing the page. */
export function mapLink(location: { latitude: number; longitude: number }) {
  const { latitude, longitude } = location;
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=18/${latitude}/${longitude}`;
}

const kindNames: Record<UnitKind, [string, string]> = {
  polideportiva: ["Pista polideportiva", "Pista polideportiva"],
  pabellon: ["Pabellón", "Pavillón"],
  futbol: ["Campo de fútbol", "Campo de fútbol"],
  tenis: ["Pista de tenis", "Pista de tenis"],
  padel: ["Pista de pádel", "Pista de pádel"],
  piscina: ["Piscina", "Piscina"],
  sala: ["Sala", "Sala"],
  gimnasio: ["Gimnasio", "Ximnasio"],
  atletismo: ["Pista de atletismo", "Pista de atletismo"],
  otro: ["Otro tipo de espacio", "Outro tipo de espazo"],
};
export function kindName(kind: UnitKind, locale: Locale) {
  return kindNames[kind][locale === "gl" ? 1 : 0];
}

/** Short facts for a list row: type, indoor or outdoor and capacity. */
export function unitFacts(profile: UnitProfile | undefined, locale: Locale) {
  if (!profile) return [];
  const gl = locale === "gl";
  return [
    profile.kind ? kindName(profile.kind, locale) : undefined,
    profile.indoor === undefined
      ? undefined
      : profile.indoor
        ? gl
          ? "Cuberto"
          : "Cubierto"
        : gl
          ? "Ao aire libre"
          : "Al aire libre",
    profile.capacity === undefined
      ? undefined
      : gl
        ? `Ata ${profile.capacity} persoas`
        : `Hasta ${profile.capacity} personas`,
  ].filter((fact): fact is string => !!fact);
}
