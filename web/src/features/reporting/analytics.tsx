import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences-provider";
import type { UsageAnalytics } from "./model";
import styles from "./reporting.module.css";

const hours = (minutes: number) => minutes / 60;
// Five steps of one hue; the number in every cell carries the value, the shade only groups it.
const level = (percent: number | null) =>
  percent === null
    ? undefined
    : percent === 0
      ? 0
      : percent < 25
        ? 1
        : percent < 50
          ? 2
          : percent < 75
            ? 3
            : 4;

/** A table frame that becomes a named, focusable scroll region only while it overflows. */
function Scroll({ label, children }: { label: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const update = () => setOverflowing(node.scrollWidth > node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={frame}
      className={styles.scroll}
      {...(overflowing
        ? { tabIndex: 0, role: "group", "aria-label": label }
        : {})}
    >
      {children}
    </div>
  );
}

export function UsageAnalysis({ analytics }: { analytics: UsageAnalytics }) {
  const { locale, t } = usePreferences();
  const tag = locale === "gl" ? "gl-ES" : "es-ES";
  const number = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
  const percent = (value: number | null) =>
    value === null
      ? t("Sin oferta", "Sen oferta")
      : `${number.format(value)} %`;
  // Explicit names: some browsers ship no Galician calendar data for Intl.
  const weekdays = [
    t("lunes", "luns"),
    t("martes", "martes"),
    t("miércoles", "mércores"),
    t("jueves", "xoves"),
    t("viernes", "venres"),
    t("sábado", "sábado"),
    t("domingo", "domingo"),
  ];
  const weekday = (day: number) => weekdays[day - 1];
  const shown = analytics.weekdayHours.map((cell) => cell.hour);
  const columns = shown.length
    ? Array.from(
        { length: Math.max(...shown) - Math.min(...shown) + 1 },
        (_, n) => Math.min(...shown) + n,
      )
    : [];
  const cell = (day: number, hour: number) =>
    analytics.weekdayHours.find((c) => c.weekday === day && c.hour === hour);
  const { cancellations: c, leadTime, attendance } = analytics;
  const leadRows = [
    ["lessThanOneDay", t("Menos de 1 día", "Menos de 1 día")],
    ["oneToThreeDays", t("De 1 a 3 días", "De 1 a 3 días")],
    ["threeToSevenDays", t("De 3 a 7 días", "De 3 a 7 días")],
    ["sevenToFourteenDays", t("De 7 a 14 días", "De 7 a 14 días")],
    ["fourteenDaysOrMore", t("14 días o más", "14 días ou máis")],
  ] as const;
  return (
    <section
      className={styles.analysis}
      aria-label={t("Análisis de uso", "Análise de uso")}
    >
      <h2>{t("Análisis de uso", "Análise de uso")}</h2>
      <p>
        {t(
          "Mismo periodo y ámbito. Solo agregados: no muestra titulares.",
          "Mesmo período e ámbito. Só agregados: non mostra titulares.",
        )}
      </p>

      <h3>{t("Ocupación por día y hora", "Ocupación por día e hora")}</h3>
      {columns.length ? (
        <>
          <p>
            {t(
              "Porcentaje de los minutos ofertados que están reservados, por día de la semana y hora local. Cuanto más contrasta la celda con el fondo, más ocupada; «—» indica que no hubo oferta.",
              "Porcentaxe dos minutos ofertados que están reservados, por día da semana e hora local. Canto máis contrasta a cela co fondo, máis ocupada; «—» indica que non houbo oferta.",
            )}
          </p>
          <Scroll
            label={t("Ocupación por día y hora", "Ocupación por día e hora")}
          >
            <table className={styles.heatmap}>
              <caption className={styles.hidden}>
                {t(
                  "Porcentaje de los minutos ofertados que están reservados, por día y hora",
                  "Porcentaxe dos minutos ofertados que están reservados, por día e hora",
                )}
              </caption>
              <thead>
                <tr>
                  <td />
                  {columns.map((hour) => (
                    <th key={hour} scope="col">
                      {`${String(hour).padStart(2, "0")}:00`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                  <tr key={day}>
                    <th scope="row">{weekday(day)}</th>
                    {columns.map((hour) => {
                      const value = cell(day, hour);
                      return (
                        <td
                          key={hour}
                          data-level={level(value?.occupancyPercent ?? null)}
                        >
                          {value && value.offeredMinutes > 0
                            ? `${number.format(value.occupancyPercent ?? 0)} %`
                            : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        </>
      ) : (
        <p>
          {t(
            "No hubo horario ofertado ni reservas en el periodo.",
            "Non houbo horario ofertado nin reservas no período.",
          )}
        </p>
      )}

      {analytics.units.length > 1 && (
        <>
          <h3>{t("Ocupación por espacio", "Ocupación por espazo")}</h3>
          <Scroll label={t("Ocupación por espacio", "Ocupación por espazo")}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t("Espacio", "Espazo")}</th>
                  <th scope="col">{t("Horas ofertadas", "Horas ofertadas")}</th>
                  <th scope="col">
                    {t("Horas reservadas", "Horas reservadas")}
                  </th>
                  <th scope="col">{t("Ocupación", "Ocupación")}</th>
                </tr>
              </thead>
              <tbody>
                {[...analytics.units]
                  .sort(
                    (a, b) =>
                      (b.occupancyPercent ?? -1) - (a.occupancyPercent ?? -1),
                  )
                  .map((unit) => (
                    <tr key={unit.unitId}>
                      <th scope="row">{unit.name ?? unit.unitId}</th>
                      <td>{number.format(hours(unit.offeredMinutes))}</td>
                      <td>{number.format(hours(unit.reservedMinutes))}</td>
                      <td>{percent(unit.occupancyPercent)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Scroll>
        </>
      )}

      <h3>{t("Cancelaciones", "Cancelacións")}</h3>
      <p>
        {t(
          `${c.cancelled} de ${c.reservations} reservas canceladas (${c.cancelledPercent === null ? "—" : `${number.format(c.cancelledPercent)} %`}): ${c.byHolder} por el titular y ${c.administrative} por el ayuntamiento.`,
          `${c.cancelled} de ${c.reservations} reservas canceladas (${c.cancelledPercent === null ? "—" : `${number.format(c.cancelledPercent)} %`}): ${c.byHolder} polo titular e ${c.administrative} polo concello.`,
        )}
      </p>

      <h3>{t("Antelación de las reservas", "Antelación das reservas")}</h3>
      <p>
        {t(
          "Tiempo entre hacer la reserva y su inicio.",
          "Tempo entre facer a reserva e o seu inicio.",
        )}
      </p>
      <Scroll
        label={t("Antelación de las reservas", "Antelación das reservas")}
      >
        <table className={styles.table}>
          <caption className={styles.hidden}>
            {t(
              "Tiempo entre hacer la reserva y su inicio",
              "Tempo entre facer a reserva e o seu inicio",
            )}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("Antelación", "Antelación")}</th>
              <th scope="col">{t("Reservas", "Reservas")}</th>
            </tr>
          </thead>
          <tbody>
            {leadRows.map(([key, label]) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td>{leadTime[key]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>

      <h3>{t("Llegadas registradas", "Chegadas rexistradas")}</h3>
      <p>
        {t(
          `${attendance.arrived} de ${attendance.finished} reservas finalizadas tienen la llegada registrada con el código QR (${attendance.arrivedPercent === null ? "—" : `${number.format(attendance.arrivedPercent)} %`}). Mide lo que registra el personal, no la asistencia real.`,
          `${attendance.arrived} de ${attendance.finished} reservas finalizadas teñen a chegada rexistrada co código QR (${attendance.arrivedPercent === null ? "—" : `${number.format(attendance.arrivedPercent)} %`}). Mide o que rexistra o persoal, non a asistencia real.`,
        )}
      </p>
    </section>
  );
}
