import { pickText } from "../lib/locale-text.ts";

/** Copy the split bar writes itself. Segment labels, the title and the unit come from the caller. */
export function splitBarText(locale: string) {
  const text = <T,>(gl: T, es: T, en: T) => pickText(locale, { gl, es, en });
  const keyHint = text("Usa as frechas para ler cada parte.", "Usa las flechas para leer cada parte.", "Use the arrow keys to read each share.");
  return {
    total: text("Total", "Total", "Total"),
    name: text("Reparto", "Reparto", "Split bar"),
    roleDescription: text("barra de reparto", "barra de reparto", "split bar"),
    keyHint,
    notShown: text("sen mostrar", "sin mostrar", "hidden"),
    off: text("Sen mostrar", "Sin mostrar", "Off"),
    segments: (name: string) => text(`${name}: partes`, `${name}: partes`, `${name} segments`),
    hidden: (label: string) => text(`${label}: non se mostra.`, `${label}: no se muestra.`, `${label} hidden.`),
    shown: (label: string) => text(`${label}: móstrase.`, `${label}: se muestra.`, `${label} shown.`),
    onlyShare: (label: string) =>
      text(
        `${label} é a única parte visible, así que segue mostrándose.`,
        `${label} es la única parte visible, así que sigue mostrándose.`,
        `${label} is the only share shown, so it stays on.`,
      ),
  };
}

export interface ShareReading {
  label: string;
  /** Formatted share, such as "80,0 %". */
  share: string;
  /** Formatted count with its unit, such as "40 reservas". */
  count: string;
}

/** One spoken reading: label, share and count. */
export const readShare = ({ label, share, count }: ShareReading) => `${label}, ${share}, ${count}`;

/** The bar's accessible description: every shown share with its count, then how to explore it. */
export function describeShares(name: string, readings: readonly ShareReading[], keyHint: string) {
  return `${name}: ${readings.map(readShare).join("; ")}. ${keyHint}`;
}
