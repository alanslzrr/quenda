import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, SlidersHorizontal } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../../app/api";
import { saveFile } from "../../app/download";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { canRefetch } from "../../app/query";
import { useSession } from "../../app/session";
import { Button } from "../../ui/button/button";
import { Combobox } from "../../ui/combobox/combobox";
import { DateRangePicker } from "../../ui/date-range-picker/date-range-picker";
import { Skeleton } from "../../ui/skeleton/skeleton";
import { Denied, endpoint, useMunicipality } from "../municipal/shared";
import { allowed, canEnter } from "../reporting/model";
import styles from "./analytics.module.css";
import {
  type AnalyticsSettings,
  addDays,
  analyticsCsv,
  comparisonName,
  isCivilDate,
  labelDate,
  type Period,
  periodName,
  presetLabel,
  presetOrder,
  presetPeriod,
  previousPeriod,
  type ReportUnit,
  type UsageAnalytics,
  validPeriod,
} from "./model";
import {
  Compliance,
  Demand,
  Evolution,
  Highlights,
  Spaces,
  Summary,
} from "./sections";
import { SettingsPanel } from "./settings-panel";
import { useAnalyticsView } from "./use-view";

const civil = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const today = () => civil(new Date());

export function UsageAnalyticsScreen() {
  const m = useMunicipality();
  return canEnter(m) ? <Loader key={m.id} /> : <Denied />;
}

/** Settings and the analysable spaces come first: they decide the first query. */
function Loader() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const settings = useReport<AnalyticsSettings>(
    `${endpoint(m.id)}/analytics/settings`,
  );
  const units = useReport<{ units: ReportUnit[]; truncated: boolean }>(
    `${endpoint(m.id)}/analytics/units`,
  );
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{t("Uso de los espacios", "Uso dos espazos")}</h1>
          <p className={styles.lead}>
            {t(
              "Cuánto se reservan los espacios del municipio, cómo evoluciona y cuándo hay más demanda. Las cifras describen reservas, no asistencia.",
              "Canto se reservan os espazos do municipio, como evoluciona e cando hai máis demanda. As cifras describen reservas, non asistencia.",
            )}
          </p>
        </div>
      </header>
      {settings.isPending || units.isPending ? (
        <Loading />
      ) : settings.data && units.data ? (
        <Report settings={settings.data} units={units.data} />
      ) : (
        <Failure
          error={settings.error ?? units.error}
          retry={() => {
            void settings.refetch();
            void units.refetch();
          }}
        />
      )}
    </div>
  );
}

/**
 * Analytics answers carry no translated text, so the language is not part of
 * the key: settling it after the first render never repeats a request. The key
 * stays under the municipal prefix, which a saved setting invalidates.
 */
function useReport<T>(path: string, enabled = true) {
  const { account } = useSession();
  const { locale } = usePreferences();
  return useQuery({
    queryKey: ["private", account?.accountId, "municipal", path],
    // Without an abort signal a remount reuses the request in flight instead of
    // cancelling and repeating it, which matters under the per-account limit.
    queryFn: () => api<T>(path, {}, locale),
    enabled: !!account && enabled,
    // The previous figures stay on screen, dimmed, while a new period loads.
    placeholderData: keepPreviousData,
    // Figures change slowly; a minute avoids repeating requests on every focus.
    staleTime: 60_000,
    refetchOnMount: (query) => canRefetch(query.state.error),
    retry: false,
  });
}
const useAnalytics = (path: string, enabled: boolean) =>
  useReport<UsageAnalytics>(path, enabled);

function Report({
  settings,
  units,
}: {
  settings: AnalyticsSettings;
  units: { units: ReportUnit[]; truncated: boolean };
}) {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const tag = locale === "gl" ? "gl-ES" : "es-ES";
  const { view, update, reset } = useAnalyticsView();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const statusId = useId();
  const municipal = allowed(m, "REPORT_READ", null);
  const [params, setParams] = useSearchParams();

  const fallback = presetPeriod(settings.defaultPeriod, today());
  const from = params.get("desde");
  const last = params.get("hasta");
  const requested =
    isCivilDate(from) && isCivilDate(last)
      ? { from, to: addDays(last, 1) }
      : undefined;
  const period: Period =
    requested && validPeriod(requested) ? requested : fallback;
  const known = new Set(units.units.map((unit) => unit.unitId));
  const chosen = params.get("espacio");
  const unitId =
    chosen && known.has(chosen)
      ? chosen
      : municipal
        ? null
        : (units.units[0]?.unitId ?? null);

  const query = (range: Period, granularity?: string) => {
    const search = new URLSearchParams({ from: range.from, to: range.to });
    if (unitId) search.set("unitId", unitId);
    if (granularity) search.set("granularity", granularity);
    return `${endpoint(m.id)}/analytics?${search}`;
  };
  const ready = municipal || unitId !== null;
  const granularity =
    view.granularity === "auto" ? undefined : view.granularity;
  const current = useAnalytics(query(period, granularity), ready);
  const before = previousPeriod(period);
  // The comparison uses the granularity of the current answer, so both series line up.
  const previous = useAnalytics(
    query(before, current.data?.granularity ?? granularity),
    ready && !!current.data && !current.isPlaceholderData,
  );

  const choose = (next: Partial<{ period: Period; unit: string | null }>) => {
    const range = next.period ?? period;
    const unit = next.unit === undefined ? unitId : next.unit;
    const search = new URLSearchParams({
      desde: range.from,
      hasta: addDays(range.to, -1),
    });
    if (unit) search.set("espacio", unit);
    setParams(search, { replace: true });
  };

  const options = useMemo(
    () => [
      ...(municipal
        ? [{ value: "all", label: t("Todos los espacios", "Todos os espazos") }]
        : []),
      ...units.units.map((unit) => ({
        value: unit.unitId,
        label: unit.name,
        group: unit.facilityName,
        ...(unit.withdrawn ? { hint: t("retirado", "retirado") } : {}),
      })),
    ],
    [municipal, units.units, t],
  );

  const data = current.data;
  const comparison = comparisonName(period, t);
  const previousData =
    previous.data && !previous.isPlaceholderData ? previous.data : undefined;

  if (!ready)
    return (
      <p role="status">
        {t(
          "Todavía no tienes espacios que analizar.",
          "Aínda non tes espazos que analizar.",
        )}
      </p>
    );

  return (
    <>
      <div className={styles.controls}>
        <div className={styles.field}>
          {/* Visible caption; the picker names itself with the same word. */}
          <span className={styles.fieldLabel} aria-hidden="true">
            {t("Periodo", "Período")}
          </span>
          <DateRangePicker
            label={t("Periodo", "Período")}
            locale={tag}
            weekStartsOn={1}
            value={{
              start: labelDate(period.from),
              end: labelDate(addDays(period.to, -1)),
            }}
            presets={presetOrder.map((preset) => ({
              label: presetLabel(preset, t),
              range: (day: Date) => {
                const range = presetPeriod(preset, civil(day));
                return {
                  start: labelDate(range.from),
                  end: labelDate(addDays(range.to, -1)),
                };
              },
            }))}
            onChange={(range) => {
              const next = {
                from: civil(range.start),
                to: addDays(civil(range.end), 1),
              };
              if (validPeriod(next)) choose({ period: next });
            }}
          />
        </div>
        <Combobox
          label={t("Espacio", "Espazo")}
          locale={tag}
          options={options}
          value={unitId ?? "all"}
          onValueChange={(value) =>
            choose({ unit: value === "all" ? null : value })
          }
          emptyMessage={t(
            "Ningún espacio coincide.",
            "Ningún espazo coincide.",
          )}
        />
        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setSettingsOpen(true)}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            {t("Ajustes de la analítica", "Axustes da analítica")}
          </Button>
          {data && (
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                saveFile(
                  `quenda-uso-espacios-${data.from}-${addDays(data.to, -1)}.csv`,
                  analyticsCsv(data, t),
                  "text/csv;charset=utf-8",
                )
              }
            >
              <Download size={16} aria-hidden="true" />
              {t("Descargar resumen", "Descargar resumo")}
            </Button>
          )}
        </div>
      </div>
      <p className={styles.hint}>
        {t(
          "Un periodo puede durar hasta 366 días. ",
          "Un período pode durar ata 366 días. ",
        )}
        {canEnter(m, true) && (
          <Link to="../exportaciones" relative="path">
            {t(
              "Exportar las reservas una a una",
              "Exportar as reservas unha a unha",
            )}
          </Link>
        )}
      </p>
      {units.truncated && (
        <p>
          {t(
            "El buscador muestra los primeros 500 espacios.",
            "O buscador mostra os primeiros 500 espazos.",
          )}
        </p>
      )}
      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        view={view}
        onViewChange={update}
        onViewReset={reset}
      />
      {current.isPending ? (
        <Skeleton
          label={t("Cargando el análisis", "Cargando a análise")}
          lines={6}
        />
      ) : !data ? (
        <Failure error={current.error} retry={() => void current.refetch()} />
      ) : (
        <div
          className={styles.results}
          aria-busy={current.isFetching || undefined}
          data-stale={current.isPlaceholderData || undefined}
        >
          <p id={statusId} role="status" className={styles.status}>
            {current.isPlaceholderData
              ? t("Actualizando…", "Actualizando…")
              : t(
                  `${periodName(period, "es")} · datos a las ${new Date(data.asOf).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`,
                  `${periodName(period, "gl")} · datos ás ${new Date(data.asOf).toLocaleTimeString(["gl-ES", "es-ES"], { hour: "2-digit", minute: "2-digit" })}`,
                )}
          </p>
          {current.isError && (
            <Failure
              error={current.error}
              retry={() => void current.refetch()}
            />
          )}
          <Highlights
            data={data}
            previous={previousData}
            comparison={comparison}
            settings={settings}
          />
          <Summary
            data={data}
            previous={previousData}
            comparison={comparison}
          />
          {view.blocks.evolution && (
            <Evolution
              data={data}
              previous={previousData}
              period={period}
              view={view}
              onViewChange={update}
            />
          )}
          <Spaces
            data={data}
            settings={settings}
            onChoose={
              municipal && !unitId ? (unit) => choose({ unit }) : undefined
            }
            view={view}
          />
          {view.blocks.demand && <Demand data={data} view={view} />}
          {view.blocks.compliance && (
            <Compliance data={data} view={view} onViewChange={update} />
          )}
        </div>
      )}
    </>
  );
}
