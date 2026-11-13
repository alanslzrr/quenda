import {
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePreferences } from "../../app/preferences-provider";
import { Badge } from "../../ui/badge/badge";
import { BarChart } from "../../ui/bar-chart/bar-chart";
import { EmptyState } from "../../ui/empty-state/empty-state";
import { LineChart } from "../../ui/line-chart/line-chart";
import { MetricCard } from "../../ui/metric-card/metric-card";
import SegmentedControl from "../../ui/segmented-control/segmented-control";
import { Sparkline } from "../../ui/sparkline/sparkline";
import { SplitBar } from "../../ui/split-bar/split-bar";
import styles from "./analytics.module.css";
import {
  type AnalyticsSettings,
  compare,
  demand,
  formatHours,
  formatNumber,
  formatPercent,
  highlights,
  type Period,
  peakText,
  periodName,
  slotLabels,
  type UnitUsage,
  type UsageAnalytics,
  type ViewPreferences,
  weekdayNames,
} from "./model";

const tagOf = (locale: "es" | "gl") => (locale === "gl" ? "gl-ES" : "es-ES");

/** A titled block of the analysis; the heading names the region. */
function Block({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.block} aria-labelledby={id}>
      <div className={styles.blockHeader}>
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A table frame that becomes a named, focusable scroll region only while it overflows. */
function Scroll({ label, children }: { label: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setOverflowing(node.scrollWidth > node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
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

/** Switches every chart of the analysis between drawing and table. */
function DisplaySwitch({
  view,
  onViewChange,
}: {
  view: ViewPreferences;
  onViewChange: (view: ViewPreferences) => void;
}) {
  const { t } = usePreferences();
  return (
    <SegmentedControl
      label={t("Mostrar como", "Mostrar como")}
      value={view.display}
      onValueChange={(display) =>
        onViewChange({
          ...view,
          display: display === "table" ? "table" : "chart",
        })
      }
      options={[
        { value: "chart", label: t("Gráfico", "Gráfico") },
        { value: "table", label: t("Tabla", "Táboa") },
      ]}
    />
  );
}

export function Highlights({
  data,
  previous,
  comparison,
  settings,
}: {
  data: UsageAnalytics;
  previous: UsageAnalytics | undefined;
  comparison: string;
  settings: AnalyticsSettings;
}) {
  const { t, locale } = usePreferences();
  const lines = highlights({
    current: data,
    previous,
    comparison,
    settings,
    t,
    locale,
  });
  return (
    <Block title={t("Lo más destacado", "O máis destacado")}>
      <ul className={styles.highlights}>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Block>
  );
}

export function Summary({
  data,
  previous,
  comparison,
}: {
  data: UsageAnalytics;
  previous: UsageAnalytics | undefined;
  comparison: string;
}) {
  const { t, locale } = usePreferences();
  const counted = (value: UsageAnalytics) => value.cancellations.reservations;
  const versus = (value: ReturnType<typeof compare>) =>
    value && { ...value, text: `${value.text} ${comparison}` };
  const cards = [
    {
      key: "occupancy",
      label: t("Ocupación", "Ocupación"),
      value: data.summary.occupancyPercent,
      suffix: "%",
      empty: t("Sin horario ofertado", "Sen horario ofertado"),
      context: t(
        "Parte del horario ofertado que estuvo reservada",
        "Parte do horario ofertado que estivo reservada",
      ),
      comparison: compare(
        data.summary.occupancyPercent,
        previous?.summary.occupancyPercent,
        "points",
        t,
        locale,
      ),
    },
    {
      key: "hours",
      label: t("Horas reservadas", "Horas reservadas"),
      value: data.summary.reservedMinutes / 60,
      suffix: "h",
      context: t(
        `De ${formatHours(data.summary.offeredMinutes, locale)} h ofertadas`,
        `De ${formatHours(data.summary.offeredMinutes, locale)} h ofertadas`,
      ),
      comparison: compare(
        data.summary.reservedMinutes,
        previous?.summary.reservedMinutes,
        "relative",
        t,
        locale,
      ),
    },
    {
      key: "reservations",
      label: t("Reservas", "Reservas"),
      value: counted(data),
      context: t(
        "Reservas que empiezan en el periodo",
        "Reservas que comezan no período",
      ),
      comparison: compare(
        counted(data),
        previous && counted(previous),
        "relative",
        t,
        locale,
      ),
    },
    {
      key: "cancelled",
      label: t("Cancelaciones", "Cancelacións"),
      value: data.cancellations.cancelledPercent,
      suffix: "%",
      empty: t("Sin reservas", "Sen reservas"),
      context: t(
        `${data.cancellations.cancelled} de ${counted(data)} reservas`,
        `${data.cancellations.cancelled} de ${counted(data)} reservas`,
      ),
      comparison: compare(
        data.cancellations.cancelledPercent,
        previous?.cancellations.cancelledPercent,
        "points",
        t,
        locale,
        true,
      ),
    },
    {
      key: "arrivals",
      label: t("Llegadas registradas", "Chegadas rexistradas"),
      value: data.attendance.arrivedPercent,
      suffix: "%",
      empty: t("Sin reservas finalizadas", "Sen reservas finalizadas"),
      context: t(
        `${data.attendance.arrived} de ${data.attendance.finished} reservas finalizadas`,
        `${data.attendance.arrived} de ${data.attendance.finished} reservas finalizadas`,
      ),
      comparison: compare(
        data.attendance.arrivedPercent,
        previous?.attendance.arrivedPercent,
        "points",
        t,
        locale,
      ),
    },
  ];
  return (
    <Block
      title={t("Resumen", "Resumo")}
      description={t(
        `Debajo de cada cifra, el cambio ${comparison}.`,
        `Debaixo de cada cifra, o cambio ${comparison}.`,
      )}
    >
      <div className={styles.metrics}>
        {cards.map((card) => {
          const shown = versus(card.comparison);
          return (
            <MetricCard
              key={card.key}
              label={card.label}
              value={card.value ?? card.empty ?? "—"}
              locale={locale}
              decimals={card.key === "hours" && (card.value ?? 0) < 10 ? 1 : 0}
              {...(card.value !== null && card.suffix
                ? { suffix: card.suffix === "%" ? " %" : " h" }
                : {})}
              context={card.context}
              {...(shown ? { comparison: shown } : {})}
            />
          );
        })}
      </div>
    </Block>
  );
}

export function Evolution({
  data,
  previous,
  period,
  view,
  onViewChange,
}: {
  data: UsageAnalytics;
  previous: UsageAnalytics | undefined;
  period: Period;
  view: ViewPreferences;
  onViewChange: (view: ViewPreferences) => void;
}) {
  const { t, locale } = usePreferences();
  const tag = tagOf(locale);
  const percent = (value: number) => `${formatNumber(value, locale)} %`;
  const showPrevious = view.previous && !!previous;
  const rows = data.series.map((slot, n) => ({
    slot,
    ...slotLabels(slot, data.granularity, locale),
    before: previous?.series[n]?.occupancyPercent ?? null,
  }));
  const unit = {
    day: t("día", "día"),
    week: t("semana", "semana"),
    month: t("mes", "mes"),
  }[data.granularity];
  return (
    <Block
      title={t("Evolución de la ocupación", "Evolución da ocupación")}
      description={t(
        `Ocupación por ${unit}. Los tramos sin horario ofertado no tienen valor.`,
        `Ocupación por ${unit}. Os tramos sen horario ofertado non teñen valor.`,
      )}
      aside={<DisplaySwitch view={view} onViewChange={onViewChange} />}
    >
      {view.display === "table" ? (
        <Scroll
          label={t("Evolución de la ocupación", "Evolución da ocupación")}
        >
          <table className={styles.table}>
            <caption className={styles.hidden}>
              {t("Evolución de la ocupación", "Evolución da ocupación")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("Periodo", "Período")}</th>
                <th scope="col">{t("Ocupación", "Ocupación")}</th>
                {showPrevious && (
                  <th scope="col">
                    {t("Periodo anterior", "Período anterior")}
                  </th>
                )}
                <th scope="col">{t("Horas reservadas", "Horas reservadas")}</th>
                <th scope="col">{t("Horas ofertadas", "Horas ofertadas")}</th>
                <th scope="col">{t("Reservas", "Reservas")}</th>
                <th scope="col">{t("Canceladas", "Canceladas")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ slot, label, before }) => (
                <tr key={slot.from}>
                  <th scope="row">{label}</th>
                  <td>{formatPercent(slot.occupancyPercent, locale)}</td>
                  {showPrevious && <td>{formatPercent(before, locale)}</td>}
                  <td>{formatHours(slot.reservedMinutes, locale)}</td>
                  <td>{formatHours(slot.offeredMinutes, locale)}</td>
                  <td>{slot.reservations}</td>
                  <td>{slot.cancelled}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : view.evolution === "bars" ? (
        <BarChart
          data={rows.map(({ slot, label, axisLabel }) => ({
            key: slot.from,
            label,
            axisLabel,
            value: slot.occupancyPercent,
          }))}
          label={t("Ocupación", "Ocupación")}
          period={periodName(period, locale)}
          locale={tag}
          categoryLabel={t("Periodo", "Período")}
          averageLabel={t("Media del periodo", "Media do período")}
          formatValue={percent}
        />
      ) : (
        <LineChart
          data={rows.map(({ slot, label, axisLabel, before }) => ({
            key: slot.from,
            label,
            axisLabel,
            values: {
              current: slot.occupancyPercent,
              ...(showPrevious ? { previous: before } : {}),
            },
          }))}
          series={[
            {
              key: "current",
              label: t("Este periodo", "Este período"),
            },
            ...(showPrevious
              ? [
                  {
                    key: "previous",
                    label: t("Periodo anterior", "Período anterior"),
                    dashed: true,
                    area: false,
                  },
                ]
              : []),
          ]}
          label={t("Evolución de la ocupación", "Evolución da ocupación")}
          locale={tag}
          categoryLabel={t("Periodo", "Período")}
          formatValue={(value) => percent(value)}
          formatTick={(value) => `${formatNumber(value, locale)} %`}
          legend={showPrevious}
        />
      )}
    </Block>
  );
}

/** Spaces grouped by facility, busiest first inside each facility. */
function groups(units: UnitUsage[]) {
  const map = new Map<string, { name: string; units: UnitUsage[] }>();
  for (const unit of units) {
    const key = unit.facilityId ?? "";
    const group = map.get(key) ?? {
      name: unit.facilityName ?? "",
      units: [],
    };
    group.units.push(unit);
    map.set(key, group);
  }
  return [...map.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({
      ...group,
      units: group.units.sort(
        (a, b) =>
          (b.occupancyPercent ?? -1) - (a.occupancyPercent ?? -1) ||
          (a.name ?? "").localeCompare(b.name ?? ""),
      ),
    }));
}

export function Spaces({
  data,
  settings,
  onChoose,
  view,
}: {
  data: UsageAnalytics;
  settings: AnalyticsSettings;
  onChoose: ((unitId: string) => void) | undefined;
  view: ViewPreferences;
}) {
  const { t, locale } = usePreferences();
  const tag = tagOf(locale);
  // Spaces with no opening hours and no bookings in the period add only noise.
  const active = data.units.filter(
    (unit) =>
      unit.offeredMinutes > 0 ||
      unit.reservedMinutes > 0 ||
      unit.reservations > 0,
  );
  const idle = data.units.length - active.length;
  const sorted = groups(active);
  return (
    <Block
      title={t("Espacios", "Espazos")}
      description={t(
        `«Alta demanda» desde el ${settings.highDemandPercent}\u00a0% de ocupación; «poco uso» por debajo del ${settings.lowUsePercent}\u00a0%. Lo fija la administración municipal.`,
        `«Alta demanda» desde o ${settings.highDemandPercent}\u00a0% de ocupación; «pouco uso» por debaixo do ${settings.lowUsePercent}\u00a0%. Fíxao a administración municipal.`,
      )}
    >
      {active.length === 0 ? (
        <EmptyState
          title={t("Sin actividad en el periodo", "Sen actividade no período")}
          description={t(
            "Ningún espacio tuvo horario ofertado ni reservas. Prueba con otro periodo.",
            "Ningún espazo tivo horario ofertado nin reservas. Proba con outro período.",
          )}
        />
      ) : (
        <Scroll label={t("Espacios", "Espazos")}>
          <table className={`${styles.table} ${styles.spaces}`}>
            <caption className={styles.hidden}>
              {t(
                "Ocupación de cada espacio, agrupados por instalación",
                "Ocupación de cada espazo, agrupados por instalación",
              )}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("Espacio", "Espazo")}</th>
                <th scope="col">{t("Ocupación", "Ocupación")}</th>
                <th scope="col">{t("Horas reservadas", "Horas reservadas")}</th>
                <th scope="col">{t("Reservas", "Reservas")}</th>
                <th scope="col">{t("Canceladas", "Canceladas")}</th>
                {view.display === "chart" && (
                  <th scope="col">{t("Tendencia", "Tendencia")}</th>
                )}
              </tr>
            </thead>
            {sorted.map((group) => (
              <tbody key={group.name}>
                <tr>
                  <th
                    className={styles.groupHeading}
                    scope="rowgroup"
                    colSpan={view.display === "chart" ? 6 : 5}
                  >
                    {group.name || t("Sin instalación", "Sen instalación")}
                  </th>
                </tr>
                {group.units.map((unit) => {
                  const level = demand(unit.occupancyPercent, settings);
                  const share = Math.min(100, unit.occupancyPercent ?? 0);
                  return (
                    <tr key={unit.unitId}>
                      <th scope="row">
                        {onChoose ? (
                          <button
                            type="button"
                            className={styles.unitButton}
                            onClick={() => onChoose(unit.unitId)}
                          >
                            {unit.name ?? unit.unitId}
                            <span className={styles.hidden}>
                              {t(
                                ": ver solo este espacio",
                                ": ver só este espazo",
                              )}
                            </span>
                          </button>
                        ) : (
                          (unit.name ?? unit.unitId)
                        )}
                      </th>
                      <td>
                        <div className={styles.occupancy}>
                          <span className={styles.bar} aria-hidden="true">
                            <span style={{ width: `${share}%` }} />
                          </span>
                          <span className={styles.value}>
                            {unit.occupancyPercent === null
                              ? t("Sin horario", "Sen horario")
                              : formatPercent(unit.occupancyPercent, locale)}
                          </span>
                          {level === "high" && (
                            <Badge tone="info" size="sm">
                              {t("Alta demanda", "Alta demanda")}
                            </Badge>
                          )}
                          {level === "low" && (
                            <Badge tone="warning" size="sm">
                              {t("Poco uso", "Pouco uso")}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td>{formatHours(unit.reservedMinutes, locale)}</td>
                      <td>{unit.reservations}</td>
                      <td>
                        {unit.reservations === 0
                          ? "—"
                          : `${unit.cancelled} (${formatPercent((unit.cancelled / unit.reservations) * 100, locale)})`}
                      </td>
                      {view.display === "chart" && (
                        <td className={styles.trend}>
                          {unit.trend.filter((value) => value !== null).length >
                          1 ? (
                            <Sparkline
                              data={unit.trend}
                              locale={tag}
                              decorative
                              width={96}
                              height={28}
                              fixedSize
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </Scroll>
      )}
      {idle > 0 && (
        <p className={styles.description}>
          {idle === 1
            ? t(
                "1 espacio sin horario ni reservas en el periodo no aparece en la tabla.",
                "1 espazo sen horario nin reservas no período non aparece na táboa.",
              )
            : t(
                `${idle} espacios sin horario ni reservas en el periodo no aparecen en la tabla.`,
                `${idle} espazos sen horario nin reservas no período non aparecen na táboa.`,
              )}
        </p>
      )}
    </Block>
  );
}

// Five steps of one hue; the number in every cell carries the value.
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

export function Demand({
  data,
  view,
}: {
  data: UsageAnalytics;
  view: ViewPreferences;
}) {
  const { t, locale } = usePreferences();
  const shown = data.weekdayHours.map((cell) => cell.hour);
  const first = shown.length ? Math.min(...shown) : 0;
  const columns = shown.length
    ? Array.from(
        { length: Math.max(...shown) - first + 1 },
        (_, n) => first + n,
      )
    : [];
  const cell = (day: number, hour: number) =>
    data.weekdayHours.find((c) => c.weekday === day && c.hour === hour);
  const hoursMode = view.demandMetric === "hours";
  const busiest = peakText(data.weekdayHours, t, locale);
  const legend = [
    [0, "0 %"],
    [1, t("menos del 25 %", "menos do 25 %")],
    [2, "25–49 %"],
    [3, "50–74 %"],
    [4, t("75 % o más", "75 % ou máis")],
  ] as const;
  return (
    <Block
      title={t("Cuándo hay más demanda", "Cando hai máis demanda")}
      description={
        hoursMode
          ? t(
              "Horas reservadas por día de la semana y hora. El tono indica la ocupación; «—», que no hubo horario ofertado.",
              "Horas reservadas por día da semana e hora. O ton indica a ocupación; «—», que non houbo horario ofertado.",
            )
          : t(
              "Ocupación por día de la semana y hora. Cuanto más intenso el tono, más ocupada; «—», que no hubo horario ofertado.",
              "Ocupación por día da semana e hora. Canto máis intenso o ton, máis ocupada; «—», que non houbo horario ofertado.",
            )
      }
    >
      {busiest && <p>{busiest}</p>}
      {columns.length === 0 ? (
        <p>
          {t(
            "No hubo horario ofertado ni reservas en el periodo.",
            "Non houbo horario ofertado nin reservas no período.",
          )}
        </p>
      ) : (
        <>
          <Scroll label={t("Demanda por día y hora", "Demanda por día e hora")}>
            <table className={styles.heatmap}>
              <caption className={styles.hidden}>
                {hoursMode
                  ? t(
                      "Horas reservadas por día y hora",
                      "Horas reservadas por día e hora",
                    )
                  : t("Ocupación por día y hora", "Ocupación por día e hora")}
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
                    <th scope="row">{weekdayNames[locale][day - 1]}</th>
                    {columns.map((hour) => {
                      const value = cell(day, hour);
                      const offered = !!value && value.offeredMinutes > 0;
                      return (
                        <td
                          key={hour}
                          data-level={level(value?.occupancyPercent ?? null)}
                        >
                          {!offered
                            ? "—"
                            : hoursMode
                              ? `${formatHours(value.reservedMinutes, locale)} h`
                              : formatPercent(
                                  value.occupancyPercent ?? 0,
                                  locale,
                                )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          <ul
            className={styles.legend}
            aria-label={t("Leyenda de tonos", "Lenda de tons")}
          >
            {legend.map(([step, text]) => (
              <li key={step}>
                <span data-level={step} aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
        </>
      )}
    </Block>
  );
}

export function Compliance({
  data,
  view,
  onViewChange,
}: {
  data: UsageAnalytics;
  view: ViewPreferences;
  onViewChange: (view: ViewPreferences) => void;
}) {
  const { t, locale } = usePreferences();
  const tag = tagOf(locale);
  const c = data.cancellations;
  const segments = [
    {
      id: "kept",
      label: t("No canceladas", "Non canceladas"),
      value: c.reservations - c.cancelled,
    },
    {
      id: "holder",
      label: t("Canceladas por la persona", "Canceladas pola persoa"),
      value: c.byHolder,
    },
    {
      id: "municipality",
      label: t("Canceladas por el ayuntamiento", "Canceladas polo concello"),
      value: c.administrative,
    },
  ];
  const lead = [
    ["lessThanOneDay", t("Menos de 1 día", "Menos de 1 día")],
    ["oneToThreeDays", t("De 1 a 3 días", "De 1 a 3 días")],
    ["threeToSevenDays", t("De 3 a 7 días", "De 3 a 7 días")],
    ["sevenToFourteenDays", t("De 7 a 14 días", "De 7 a 14 días")],
    ["fourteenDaysOrMore", t("14 días o más", "14 días ou máis")],
  ] as const;
  const a = data.attendance;
  return (
    <Block
      title={t("¿Se cumplen las reservas?", "Cúmprense as reservas?")}
      description={t(
        "Cancelaciones, antelación y llegadas de las reservas que empiezan en el periodo.",
        "Cancelacións, antelación e chegadas das reservas que comezan no período.",
      )}
      aside={<DisplaySwitch view={view} onViewChange={onViewChange} />}
    >
      <h3>{t("Cancelaciones", "Cancelacións")}</h3>
      {c.reservations === 0 ? (
        <p>
          {t(
            "Ninguna reserva empezó en el periodo.",
            "Ningunha reserva comezou no período.",
          )}
        </p>
      ) : view.display === "table" ? (
        <table className={styles.table}>
          <caption className={styles.hidden}>
            {t("Cancelaciones", "Cancelacións")}
          </caption>
          <tbody>
            {segments.map((segment) => (
              <tr key={segment.id}>
                <th scope="row">{segment.label}</th>
                <td>{segment.value}</td>
                <td>
                  {formatPercent(
                    (segment.value / c.reservations) * 100,
                    locale,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SplitBar
          segments={segments}
          locale={tag}
          label={t("Reparto de las reservas", "Reparto das reservas")}
          totalLabel={t("reservas", "reservas")}
        />
      )}

      <h3>{t("Antelación de las reservas", "Antelación das reservas")}</h3>
      <p className={styles.description}>
        {t(
          "Tiempo entre hacer la reserva y su inicio.",
          "Tempo entre facer a reserva e o seu inicio.",
        )}
      </p>
      {/* Five categories read best as a table; the bars only illustrate the counts. */}
      <table className={`${styles.table} ${styles.shares}`}>
        <caption className={styles.hidden}>
          {t("Antelación de las reservas", "Antelación das reservas")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("Antelación", "Antelación")}</th>
            <th scope="col">{t("Reservas", "Reservas")}</th>
          </tr>
        </thead>
        <tbody>
          {lead.map(([key, label]) => {
            const count = data.leadTime[key];
            const share = c.reservations ? (count / c.reservations) * 100 : 0;
            return (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td>
                  <div className={styles.occupancy}>
                    {view.display === "chart" && (
                      <span className={styles.bar} aria-hidden="true">
                        <span style={{ width: `${share}%` }} />
                      </span>
                    )}
                    <span className={styles.value}>
                      {formatNumber(count, locale)}
                      {c.reservations > 0 &&
                        ` (${formatPercent(share, locale)})`}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>{t("Llegadas registradas", "Chegadas rexistradas")}</h3>
      <p>
        {a.finished === 0
          ? t(
              "Todavía no hay reservas finalizadas en el periodo.",
              "Aínda non hai reservas finalizadas no período.",
            )
          : t(
              `${a.arrived} de ${a.finished} reservas finalizadas tienen la llegada registrada con el código QR (${formatPercent(a.arrivedPercent, "es")}). Mide lo que registra el personal, no la asistencia real.`,
              `${a.arrived} de ${a.finished} reservas finalizadas teñen a chegada rexistrada co código QR (${formatPercent(a.arrivedPercent, "gl")}). Mide o que rexistra o persoal, non a asistencia real.`,
            )}
      </p>
    </Block>
  );
}
