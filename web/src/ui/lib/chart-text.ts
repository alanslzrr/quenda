import { noDataText, pickText } from "./locale-text.ts";

/** Copy that the charts write themselves: assistive names, summaries, empty and loading states. Everything else comes from the caller. */
export function chartText(locale: string) {
  const text = <T,>(gl: T, es: T, en: T) => pickText(locale, { gl, es, en });
  return {
    empty: text("Non hai datos para este período", "No hay datos para este periodo", "No data for this range"),
    date: text("Data", "Fecha", "Date"),
    category: text("Categoría", "Categoría", "Category"),
    loading: text("Cargando", "Cargando", "Loading"),
    noData: noDataText(locale),
    average: text("Media", "Media", "Average"),
    value: text("Valor", "Valor", "Value"),
    latest: text("Último valor", "Último valor", "Latest"),
    chooseSeries: text("Escolle unha serie para mostrar", "Elige una serie para mostrar", "Choose a series to show"),
    seriesGroup: (label: string) => text(`Series: ${label}`, `Series: ${label}`, `${label} series`),
    seriesShown: (shown: number, total: number) =>
      text(`${shown} de ${total} series visibles`, `${shown} de ${total} series visibles`, `${shown} of ${total} series shown`),
    explore: (label: string, by: string) =>
      text(`${label}: explorar por ${by.toLocaleLowerCase("gl")}`, `${label}: explorar por ${by.toLocaleLowerCase("es")}`, `${label}, explore by ${by.toLowerCase()}`),
    exploreValues: (label: string) => text(`${label}: explorar valores`, `${label}: explorar valores`, `${label}, explore values`),
    span: (from: string, to: string) => text(`desde ${from} ata ${to}`, `desde ${from} hasta ${to}`, `${from} to ${to}`),
    latestValue: (series: string, value: string, when?: string) =>
      text(
        `${series}, último valor ${value}${when ? ` (${when})` : ""}`,
        `${series}, último valor ${value}${when ? ` (${when})` : ""}`,
        `${series}, latest ${value}${when ? ` (${when})` : ""}`,
      ),
    highest: (label: string, value: string) => text(`Máximo: ${label}, ${value}`, `Máximo: ${label}, ${value}`, `Highest ${label}, ${value}`),
    lowest: (label: string, value: string) => text(`Mínimo: ${label}, ${value}`, `Mínimo: ${label}, ${value}`, `Lowest ${label}, ${value}`),
    pointOf: (index: number, count: number) => text(`Punto ${index} de ${count}`, `Punto ${index} de ${count}`, `Point ${index} of ${count}`),
    position: (index: number, count: number) => text(`${index} de ${count}`, `${index} de ${count}`, `${index} of ${count}`),
  };
}

export type ChartText = ReturnType<typeof chartText>;

/** A formatted value with its unit, separated by a space. */
export const withUnit = (value: string, unit?: string) => (unit ? `${value} ${unit}` : value);
