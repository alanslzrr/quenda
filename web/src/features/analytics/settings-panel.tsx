import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Dialog, DialogContent } from "../../ui/dialog/dialog";
import { NumberField } from "../../ui/number-field/number-field";
import SegmentedControl from "../../ui/segmented-control/segmented-control";
import { Select } from "../../ui/select/select";
import { endpoint, MunicipalForm, useMunicipality } from "../municipal/shared";
import styles from "./analytics.module.css";
import {
  type AnalyticsSettings,
  type DefaultPeriod,
  presetLabel,
  presetOrder,
  type ViewPreferences,
} from "./model";

export function SettingsPanel({
  open,
  onOpenChange,
  settings,
  view,
  onViewChange,
  onViewReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AnalyticsSettings;
  view: ViewPreferences;
  onViewChange: (view: ViewPreferences) => void;
  onViewReset: () => void;
}) {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const tag = locale === "gl" ? "gl-ES" : "es-ES";
  const blocks = [
    ["evolution", t("Evolución de la ocupación", "Evolución da ocupación")],
    ["demand", t("Cuándo hay más demanda", "Cando hai máis demanda")],
    ["compliance", t("¿Se cumplen las reservas?", "Cúmprense as reservas?")],
  ] as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("Ajustes de la analítica", "Axustes da analítica")}
        description={t(
          "Los ajustes del municipio afectan a todo el personal; los personales, solo a este navegador.",
          "Os axustes do municipio afectan a todo o persoal; os persoais, só a este navegador.",
        )}
        closeLabel={t("Cerrar", "Pechar")}
      >
        <div className={styles.settings}>
          <section aria-labelledby="analytics-personal">
            <h3 id="analytics-personal">{t("Tu vista", "A túa vista")}</h3>
            <p className={styles.description}>
              {t(
                "Solo cambian cómo ves los datos, nunca los cálculos.",
                "Só cambian como ves os datos, nunca os cálculos.",
              )}
            </p>
            <div className={styles.field}>
              <span className={styles.fieldLabel} aria-hidden="true">
                {t("Mostrar los datos como", "Mostrar os datos como")}
              </span>
              <SegmentedControl
                label={t("Mostrar los datos como", "Mostrar os datos como")}
                value={view.display}
                onValueChange={(value) =>
                  onViewChange({
                    ...view,
                    display: value === "table" ? "table" : "chart",
                  })
                }
                options={[
                  { value: "chart", label: t("Gráficos", "Gráficos") },
                  { value: "table", label: t("Tablas", "Táboas") },
                ]}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel} aria-hidden="true">
                {t("Gráfico de evolución", "Gráfico de evolución")}
              </span>
              <SegmentedControl
                label={t("Gráfico de evolución", "Gráfico de evolución")}
                value={view.evolution}
                onValueChange={(value) =>
                  onViewChange({
                    ...view,
                    evolution: value === "bars" ? "bars" : "line",
                  })
                }
                options={[
                  { value: "line", label: t("Línea", "Liña") },
                  { value: "bars", label: t("Barras", "Barras") },
                ]}
              />
            </div>
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
            <Checkbox
              label={t(
                "Mostrar el periodo anterior en la evolución",
                "Mostrar o período anterior na evolución",
              )}
              checked={view.previous}
              onCheckedChange={(checked) =>
                onViewChange({ ...view, previous: checked === true })
              }
            />
            <div className={styles.field}>
              <span className={styles.fieldLabel} aria-hidden="true">
                {t("Demanda por día y hora", "Demanda por día e hora")}
              </span>
              <SegmentedControl
                label={t("Demanda por día y hora", "Demanda por día e hora")}
                value={view.demandMetric}
                onValueChange={(value) =>
                  onViewChange({
                    ...view,
                    demandMetric: value === "hours" ? "hours" : "percent",
                  })
                }
                options={[
                  { value: "percent", label: t("Ocupación", "Ocupación") },
                  {
                    value: "hours",
                    label: t("Horas reservadas", "Horas reservadas"),
                  },
                ]}
              />
            </div>
            <fieldset className={styles.fieldset}>
              <legend>{t("Bloques visibles", "Bloques visibles")}</legend>
              <p className={styles.description}>
                {t(
                  "El resumen y la tabla de espacios siempre se muestran.",
                  "O resumo e a táboa de espazos sempre se mostran.",
                )}
              </p>
              {blocks.map(([key, label]) => (
                <Checkbox
                  key={key}
                  label={label}
                  checked={view.blocks[key]}
                  onCheckedChange={(checked) =>
                    onViewChange({
                      ...view,
                      blocks: { ...view.blocks, [key]: checked === true },
                    })
                  }
                />
              ))}
            </fieldset>
            <Button type="button" variant="ghost" onClick={onViewReset}>
              {t("Restablecer mi vista", "Restablecer a miña vista")}
            </Button>
          </section>

          <section aria-labelledby="analytics-municipal">
            <h3 id="analytics-municipal">
              {t("Para todo el municipio", "Para todo o municipio")}
            </h3>
            {m.administrator ? (
              <MunicipalForm
                path={`${endpoint(m.id)}/analytics/settings`}
                method="PUT"
                label={t(
                  "Guardar para el municipio",
                  "Gardar para o municipio",
                )}
                body={(data) => {
                  const high = Number(textField(data, "highDemandPercent"));
                  const low = Number(textField(data, "lowUsePercent"));
                  if (!(low < high))
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
                    highDemandPercent: high,
                    lowUsePercent: low,
                    defaultPeriod: textField(data, "defaultPeriod"),
                  };
                }}
              >
                <NumberField
                  name="highDemandPercent"
                  label={t("Alta demanda desde (%)", "Alta demanda desde (%)")}
                  locale={tag}
                  defaultValue={settings.highDemandPercent}
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
                  min={1}
                  max={99}
                  step={1}
                />
                <Select
                  name="defaultPeriod"
                  label={t("Periodo al abrir", "Período ao abrir")}
                  defaultValue={settings.defaultPeriod}
                  options={presetOrder.map((preset: DefaultPeriod) => ({
                    value: preset,
                    label: presetLabel(preset, t),
                  }))}
                />
                <p className={styles.description}>
                  {t(
                    "Las etiquetas no cambian ningún cálculo. Cada cambio queda registrado.",
                    "As etiquetas non cambian ningún cálculo. Cada cambio queda rexistrado.",
                  )}
                </p>
              </MunicipalForm>
            ) : (
              <p>
                {t(
                  `Alta demanda desde el ${settings.highDemandPercent} %, poco uso por debajo del ${settings.lowUsePercent} % y, al abrir, ${presetLabel(settings.defaultPeriod, t).toLowerCase()}. Solo la administración municipal puede cambiarlo.`,
                  `Alta demanda desde o ${settings.highDemandPercent} %, pouco uso por debaixo do ${settings.lowUsePercent} % e, ao abrir, ${presetLabel(settings.defaultPeriod, t).toLowerCase()}. Só a administración municipal pode cambialo.`,
                )}
              </p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
