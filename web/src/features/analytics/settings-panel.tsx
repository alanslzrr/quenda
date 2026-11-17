import { CalendarRange, ChartColumn, ListChecks, Table2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Badge } from "../../ui/badge/badge";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Dialog, DialogContent } from "../../ui/dialog/dialog";
import { NumberField } from "../../ui/number-field/number-field";
import { Select } from "../../ui/select/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs/tabs";
import {
  AnchoredTooltip,
  useHoverGrace,
} from "../../ui/tooltip/anchored-tooltip";
import { endpoint, MunicipalForm, useMunicipality } from "../municipal/shared";
import {
  type AnalyticsSettings,
  type DefaultPeriod,
  demand,
  formatHours,
  formatPercent,
  presetLabel,
  presetOrder,
  type UsageAnalytics,
  type ViewPreferences,
} from "./model";
import styles from "./settings-panel.module.css";
import { MiniDemand, MiniEvolution } from "./settings-previews";

type Show = (anchor: HTMLElement, content: ReactNode) => void;

interface Option<T extends string> {
  value: T;
  label: string;
  /** Always visible inside the card. */
  thumb: ReactNode;
  /** Shown larger on hover or focus: how the screen will look with this option. */
  preview: ReactNode;
}

/**
 * Choices drawn as cards: each one carries a miniature of the result, and pointing at it or reaching it by keyboard
 * shows a larger preview built from the period on screen. Native radio inputs keep the group's keyboard and naming.
 */
function ChoiceCards<T extends string>({
  legend,
  value,
  options,
  onChange,
  show,
  hide,
  leave,
  describedBy,
}: {
  legend: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  show: Show;
  hide: () => void;
  /** Hides after a short grace, so the pointer can move onto the preview. */
  leave: () => void;
  describedBy: (anchor: HTMLElement | null) => string | undefined;
}) {
  const name = useId();
  const [focused, setFocused] = useState<HTMLElement | null>(null);
  return (
    <fieldset className={styles.group}>
      <legend>{legend}</legend>
      <div className={styles.cards}>
        {options.map((option) => (
          <label
            key={option.value}
            className={styles.card}
            onPointerEnter={(event) =>
              event.pointerType === "mouse" &&
              show(event.currentTarget, option.preview)
            }
            onPointerLeave={(event) =>
              event.pointerType === "mouse" && !focused && leave()
            }
          >
            <input
              type="radio"
              className={styles.input}
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              aria-describedby={describedBy(focused)}
              onFocus={(event) => {
                const card = event.currentTarget.parentElement;
                if (!card) return;
                setFocused(card);
                show(card, option.preview);
              }}
              onBlur={() => {
                setFocused(null);
                hide();
              }}
            />
            <span className={styles.thumb}>{option.thumb}</span>
            <span className={styles.cardLabel}>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Preview({
  children,
  caption,
}: {
  children: ReactNode;
  caption: string;
}) {
  return (
    <span className={styles.preview}>
      <span className={styles.previewFrame}>{children}</span>
      <span className={styles.previewCaption}>{caption}</span>
    </span>
  );
}

export function SettingsPanel({
  open,
  onOpenChange,
  settings,
  view,
  onViewChange,
  onViewReset,
  data,
  previous,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AnalyticsSettings;
  view: ViewPreferences;
  onViewChange: (view: ViewPreferences) => void;
  onViewReset: () => void;
  /** The period on screen, so previews draw the person's own numbers. */
  data?: UsageAnalytics | undefined;
  previous?: UsageAnalytics | undefined;
}) {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const tag = locale === "gl" ? "gl-ES" : "es-ES";
  const tipId = useId();
  const [tab, setTab] = useState("view");
  const [tip, setTip] = useState<{ anchor: HTMLElement; content: ReactNode }>();
  const grace = useHoverGrace(() => setTip(undefined));
  const show: Show = (anchor, content) => {
    grace.stay();
    setTip({ anchor, content });
  };
  const hide = () => {
    grace.stay();
    setTip(undefined);
  };
  const describedBy = (anchor: HTMLElement | null) =>
    anchor && tip?.anchor === anchor ? tipId : undefined;
  const [high, setHigh] = useState(settings.highDemandPercent);
  const [low, setLow] = useState(settings.lowUsePercent);

  const series = data?.series.map((slot) => slot.occupancyPercent) ?? [];
  const before = previous?.series.map((slot) => slot.occupancyPercent);
  const shownBefore = view.previous ? before : undefined;
  const evolution = (
    kind: "line" | "bars" | "table",
    withPrevious: (number | null)[] | undefined,
    large: boolean,
  ) => (
    <MiniEvolution
      current={series}
      previous={withPrevious}
      kind={kind}
      width={large ? 264 : 88}
      height={large ? 96 : 40}
    />
  );
  // The busiest hours of the period, written the way each metric writes them.
  const busiest = [...(data?.weekdayHours ?? [])]
    .filter((cell) => cell.offeredMinutes > 0)
    .sort((a, b) => (b.occupancyPercent ?? 0) - (a.occupancyPercent ?? 0))
    .slice(0, 4);
  const demandCells = (metric: "percent" | "hours") =>
    (busiest.length
      ? busiest
      : [
          { occupancyPercent: 80, reservedMinutes: 240 },
          { occupancyPercent: 55, reservedMinutes: 165 },
          { occupancyPercent: 30, reservedMinutes: 90 },
          { occupancyPercent: 10, reservedMinutes: 30 },
        ]
    ).map((cell) => {
      const percent = cell.occupancyPercent ?? 0;
      return {
        text:
          metric === "hours"
            ? `${formatHours(cell.reservedMinutes, locale)} h`
            : formatPercent(percent, locale),
        level: percent >= 75 ? 4 : percent >= 50 ? 3 : percent >= 25 ? 2 : 1,
      };
    });
  const tablesNote =
    view.display === "table"
      ? t(
          " Ahora ves tablas: se aplica al volver a gráficos.",
          " Agora ves táboas: aplícase ao volver a gráficos.",
        )
      : "";

  const blocks = [
    [
      "evolution",
      t("Evolución de la ocupación", "Evolución da ocupación"),
      <ChartColumn key="i" size={16} aria-hidden="true" />,
    ],
    [
      "demand",
      t("Cuándo hay más demanda", "Cando hai máis demanda"),
      <CalendarRange key="i" size={16} aria-hidden="true" />,
    ],
    [
      "compliance",
      t("¿Se cumplen las reservas?", "Cúmprense as reservas?"),
      <ListChecks key="i" size={16} aria-hidden="true" />,
    ],
  ] as const;

  // How the thresholds being typed would label the spaces of the period on screen.
  const valid = low < high;
  const counted = (data?.units ?? []).map((unit) =>
    demand(unit.occupancyPercent, {
      highDemandPercent: high,
      lowUsePercent: low,
    }),
  );
  const highCount = counted.filter((level) => level === "high").length;
  const lowCount = counted.filter((level) => level === "low").length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) hide();
        onOpenChange(next);
      }}
    >
      <DialogContent
        size="lg"
        title={t("Ajustes de la analítica", "Axustes da analítica")}
        description={t(
          "Tu vista solo cambia cómo ves los datos en este navegador. Los ajustes del municipio afectan a todo el personal.",
          "A túa vista só cambia como ves os datos neste navegador. Os axustes do municipio afectan a todo o persoal.",
        )}
        closeLabel={t("Cerrar", "Pechar")}
        onEscapeKeyDown={(event) => {
          // Escape first dismisses an open preview (WCAG 1.4.13) and keeps the dialog, and its unsaved edits, open.
          // Radix listens on the document in the capture phase, so cancelling here is what stops the dismissal.
          if (!tip) return;
          event.preventDefault();
          hide();
        }}
      >
        <Tabs
          value={tab}
          onValueChange={(next) => {
            hide();
            setTab(next);
          }}
        >
          <TabsList
            aria-label={t("Ajustes", "Axustes")}
            scrollLabels={{
              previous: t("Anterior", "Anterior"),
              next: t("Siguiente", "Seguinte"),
            }}
          >
            <TabsTrigger value="view">
              {t("Tu vista", "A túa vista")}
            </TabsTrigger>
            <TabsTrigger value="municipality">
              {t("Para todo el municipio", "Para todo o municipio")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="view" forceMount className={styles.panel}>
            <p className={styles.lead}>
              {t(
                "Pasa por cada opción para ver cómo quedará con los datos de este periodo. Los cambios se aplican al momento y nunca alteran los cálculos.",
                "Pasa por cada opción para ver como quedará cos datos deste período. Os cambios aplícanse ao momento e nunca alteran os cálculos.",
              )}
            </p>
            <div className={styles.columns}>
              <ChoiceCards
                legend={t("Mostrar los datos como", "Mostrar os datos como")}
                value={view.display}
                onChange={(display) => onViewChange({ ...view, display })}
                show={show}
                hide={hide}
                leave={grace.leave}
                describedBy={describedBy}
                options={[
                  {
                    value: "chart",
                    label: t("Gráficos", "Gráficos"),
                    thumb: evolution(view.evolution, shownBefore, false),
                    preview: (
                      <Preview
                        caption={t(
                          "Cada bloque se dibuja como gráfico.",
                          "Cada bloque debúxase como gráfico.",
                        )}
                      >
                        {evolution(view.evolution, shownBefore, true)}
                      </Preview>
                    ),
                  },
                  {
                    value: "table",
                    label: t("Tablas", "Táboas"),
                    thumb: evolution("table", undefined, false),
                    preview: (
                      <Preview
                        caption={t(
                          "Cada bloque muestra sus cifras en una tabla.",
                          "Cada bloque mostra as súas cifras nunha táboa.",
                        )}
                      >
                        {evolution("table", undefined, true)}
                      </Preview>
                    ),
                  },
                ]}
              />
              <ChoiceCards
                legend={t("Gráfico de evolución", "Gráfico de evolución")}
                value={view.evolution}
                onChange={(evolutionKind) =>
                  onViewChange({ ...view, evolution: evolutionKind })
                }
                show={show}
                hide={hide}
                leave={grace.leave}
                describedBy={describedBy}
                options={[
                  {
                    value: "line",
                    label: t("Línea", "Liña"),
                    thumb: evolution("line", shownBefore, false),
                    preview: (
                      <Preview
                        caption={
                          t(
                            "Una línea une la ocupación de cada tramo.",
                            "Unha liña une a ocupación de cada tramo.",
                          ) + tablesNote
                        }
                      >
                        {evolution("line", shownBefore, true)}
                      </Preview>
                    ),
                  },
                  {
                    value: "bars",
                    label: t("Barras", "Barras"),
                    thumb: evolution("bars", shownBefore, false),
                    preview: (
                      <Preview
                        caption={
                          t(
                            "Una barra por tramo, fácil de comparar.",
                            "Unha barra por tramo, doada de comparar.",
                          ) + tablesNote
                        }
                      >
                        {evolution("bars", shownBefore, true)}
                      </Preview>
                    ),
                  },
                ]}
              />
              <ChoiceCards
                legend={t(
                  "Periodo anterior en la evolución",
                  "Período anterior na evolución",
                )}
                value={view.previous ? "shown" : "hidden"}
                onChange={(shown) =>
                  onViewChange({ ...view, previous: shown === "shown" })
                }
                show={show}
                hide={hide}
                leave={grace.leave}
                describedBy={describedBy}
                options={[
                  {
                    value: "shown",
                    label: t("Mostrar", "Mostrar"),
                    thumb: evolution(
                      view.evolution,
                      before ??
                        series.map((v) => (v === null ? null : v * 0.8)),
                      false,
                    ),
                    preview: (
                      <Preview
                        caption={t(
                          "El periodo anterior aparece en discontinua para comparar.",
                          "O período anterior aparece en descontinua para comparar.",
                        )}
                      >
                        {evolution(
                          view.evolution,
                          before ??
                            series.map((v) => (v === null ? null : v * 0.8)),
                          true,
                        )}
                      </Preview>
                    ),
                  },
                  {
                    value: "hidden",
                    label: t("Ocultar", "Ocultar"),
                    thumb: evolution(view.evolution, undefined, false),
                    preview: (
                      <Preview
                        caption={t(
                          "Solo el periodo elegido.",
                          "Só o período escollido.",
                        )}
                      >
                        {evolution(view.evolution, undefined, true)}
                      </Preview>
                    ),
                  },
                ]}
              />
              <ChoiceCards
                legend={t("Demanda por día y hora", "Demanda por día e hora")}
                value={view.demandMetric}
                onChange={(demandMetric) =>
                  onViewChange({ ...view, demandMetric })
                }
                show={show}
                hide={hide}
                leave={grace.leave}
                describedBy={describedBy}
                options={[
                  {
                    value: "percent",
                    label: t("Ocupación", "Ocupación"),
                    thumb: (
                      <MiniDemand
                        cells={demandCells("percent").slice(0, 3)}
                        compact
                      />
                    ),
                    preview: (
                      <Preview
                        caption={t(
                          "Cada hora muestra qué parte del horario ofertado se reservó.",
                          "Cada hora mostra que parte do horario ofertado se reservou.",
                        )}
                      >
                        <MiniDemand cells={demandCells("percent")} />
                      </Preview>
                    ),
                  },
                  {
                    value: "hours",
                    label: t("Horas reservadas", "Horas reservadas"),
                    thumb: (
                      <MiniDemand
                        cells={demandCells("hours").slice(0, 3)}
                        compact
                      />
                    ),
                    preview: (
                      <Preview
                        caption={t(
                          "Cada hora muestra cuántas horas se reservaron; el tono sigue indicando la ocupación.",
                          "Cada hora mostra cantas horas se reservaron; o ton segue indicando a ocupación.",
                        )}
                      >
                        <MiniDemand cells={demandCells("hours")} />
                      </Preview>
                    ),
                  },
                ]}
              />
            </div>
            <div className={styles.row}>
              <Select
                label={t("Agrupar la evolución", "Agrupar a evolución")}
                value={view.granularity}
                onValueChange={(value) =>
                  onViewChange({
                    ...view,
                    granularity:
                      value === "day" || value === "week" || value === "month"
                        ? value
                        : "auto",
                  })
                }
                options={[
                  {
                    value: "auto",
                    label: t(
                      "Automático según el periodo",
                      "Automático segundo o período",
                    ),
                  },
                  { value: "day", label: t("Por días", "Por días") },
                  { value: "week", label: t("Por semanas", "Por semanas") },
                  { value: "month", label: t("Por meses", "Por meses") },
                ]}
              />
            </div>
            <fieldset className={styles.group}>
              <legend>{t("Bloques visibles", "Bloques visibles")}</legend>
              <p className={styles.hint}>
                {t(
                  "El resumen y la tabla de espacios siempre se muestran.",
                  "O resumo e a táboa de espazos sempre se mostran.",
                )}
              </p>
              <div className={styles.blocks}>
                {blocks.map(([key, label, icon]) => (
                  <div key={key} className={styles.block}>
                    {icon}
                    <Checkbox
                      label={label}
                      checked={view.blocks[key]}
                      onCheckedChange={(checked) =>
                        onViewChange({
                          ...view,
                          blocks: { ...view.blocks, [key]: checked === true },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </fieldset>
            <div className={styles.footer}>
              <Button type="button" variant="secondary" onClick={onViewReset}>
                {t("Restablecer mi vista", "Restablecer a miña vista")}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="municipality" forceMount className={styles.panel}>
            {m.administrator ? (
              <MunicipalForm
                path={`${endpoint(m.id)}/analytics/settings`}
                method="PUT"
                label={t(
                  "Guardar para el municipio",
                  "Gardar para o municipio",
                )}
                body={(form) => {
                  const nextHigh = Number(textField(form, "highDemandPercent"));
                  const nextLow = Number(textField(form, "lowUsePercent"));
                  if (!(nextLow < nextHigh))
                    throw new ApiError(
                      400,
                      "INVALID_INPUT",
                      t(
                        "«Poco uso» debe ser menor que «alta demanda».",
                        "«Pouco uso» debe ser menor que «alta demanda».",
                      ),
                    );
                  return {
                    expectedVersion: settings.version,
                    highDemandPercent: nextHigh,
                    lowUsePercent: nextLow,
                    defaultPeriod: textField(form, "defaultPeriod"),
                  };
                }}
              >
                <p className={styles.lead}>
                  {t(
                    "Deciden qué espacios se marcan como «Alta demanda» o «Poco uso» y qué periodo se abre primero, para todo el personal. Cada cambio queda registrado.",
                    "Deciden que espazos se marcan como «Alta demanda» ou «Pouco uso» e que período se abre primeiro, para todo o persoal. Cada cambio queda rexistrado.",
                  )}
                </p>
                <div className={styles.thresholds}>
                  <NumberField
                    name="highDemandPercent"
                    label={t(
                      "Alta demanda desde (%)",
                      "Alta demanda desde (%)",
                    )}
                    locale={tag}
                    defaultValue={settings.highDemandPercent}
                    onValueChange={setHigh}
                    min={1}
                    max={99}
                    step={1}
                  />
                  <NumberField
                    name="lowUsePercent"
                    label={t(
                      "Poco uso por debajo de (%)",
                      "Pouco uso por debaixo de (%)",
                    )}
                    locale={tag}
                    defaultValue={settings.lowUsePercent}
                    onValueChange={setLow}
                    min={1}
                    max={99}
                    step={1}
                  />
                </div>
                <div className={styles.effect} aria-live="polite">
                  {!valid ? (
                    <p className={styles.invalid}>
                      {t(
                        "«Poco uso» debe ser menor que «alta demanda».",
                        "«Pouco uso» debe ser menor que «alta demanda».",
                      )}
                    </p>
                  ) : data ? (
                    <>
                      <p className={styles.hint}>
                        {t(
                          "Con estos valores, en el periodo que estás viendo:",
                          "Con estes valores, no período que estás a ver:",
                        )}
                      </p>
                      <p className={styles.counts}>
                        <Badge tone="info" size="sm">
                          {t("Alta demanda", "Alta demanda")}
                        </Badge>
                        {t(
                          `${highCount} ${highCount === 1 ? "espacio" : "espacios"}`,
                          `${highCount} ${highCount === 1 ? "espazo" : "espazos"}`,
                        )}
                        <Badge tone="warning" size="sm">
                          {t("Poco uso", "Pouco uso")}
                        </Badge>
                        {t(
                          `${lowCount} ${lowCount === 1 ? "espacio" : "espacios"}`,
                          `${lowCount} ${lowCount === 1 ? "espazo" : "espazos"}`,
                        )}
                      </p>
                    </>
                  ) : null}
                </div>
                <Select
                  name="defaultPeriod"
                  label={t("Periodo al abrir", "Período ao abrir")}
                  defaultValue={settings.defaultPeriod}
                  options={presetOrder.map((preset: DefaultPeriod) => ({
                    value: preset,
                    label: presetLabel(preset, t),
                  }))}
                />
              </MunicipalForm>
            ) : (
              <div className={styles.readOnly}>
                <Table2 size={16} aria-hidden="true" />
                <p>
                  {t(
                    `Alta demanda desde el ${settings.highDemandPercent} %, poco uso por debajo del ${settings.lowUsePercent} % y, al abrir, ${presetLabel(settings.defaultPeriod, t).toLowerCase()}. Solo la administración municipal puede cambiarlo.`,
                    `Alta demanda desde o ${settings.highDemandPercent} %, pouco uso por debaixo do ${settings.lowUsePercent} % e, ao abrir, ${presetLabel(settings.defaultPeriod, t).toLowerCase()}. Só a administración municipal pode cambialo.`,
                  )}
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>
        <AnchoredTooltip
          anchor={tip?.anchor ?? null}
          id={tipId}
          onPointerEnter={grace.stay}
          onPointerLeave={() => {
            // A preview opened by keyboard focus stays while its card holds the focus.
            if (!tip?.anchor.contains(document.activeElement)) grace.leave();
          }}
        >
          {tip?.content}
        </AnchoredTooltip>
      </DialogContent>
    </Dialog>
  );
}
