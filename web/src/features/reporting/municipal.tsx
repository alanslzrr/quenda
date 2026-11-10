import { useState } from "react";
import { ActionForm, textField } from "../../app/action";
import { ApiError, api } from "../../app/api";
import { saveFile } from "../../app/download";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { MetricCard } from "../../ui/metric-card/metric-card";
import { Select } from "../../ui/select/select";
import { Denied, endpoint, useMunicipality } from "../municipal/shared";
import { UsageAnalysis } from "./analytics";
import { PeriodFields, ScopeField } from "./fields";
import {
  allowed,
  canEnter,
  canExport,
  type Indicators,
  type UsageAnalytics,
  validPeriod,
} from "./model";
import styles from "./reporting.module.css";
export function MunicipalIndicators({
  exporting = false,
}: {
  exporting?: boolean;
}) {
  const m = useMunicipality();
  return canEnter(m, exporting) ? (
    <Query key={`${m.id}:${exporting}`} exporting={exporting} />
  ) : (
    <Denied />
  );
}
function Query({ exporting }: { exporting: boolean }) {
  const m = useMunicipality(),
    { t, locale } = usePreferences();
  const [result, setResult] = useState<Indicators>();
  // Requested on demand for the period and scope of the indicators shown.
  const [analytics, setAnalytics] = useState<UsageAnalytics>();
  const [scope, setScope] = useState<string>();
  const [download, setDownload] = useState(false);
  const [format, setFormat] = useState<"json" | "csv">("json");
  return (
    <div className={styles.surface}>
      <h1>
        {exporting
          ? t("Exportar reservas", "Exportar reservas")
          : t("Indicadores municipales", "Indicadores municipais")}
      </h1>
      <p>
        {exporting
          ? t(
              "JSON quenda.reservations, versión 3, o una tabla CSV con una fila por reserva. Incluye reservas que solapan el periodo, conservando sus intervalos completos. El JSON añade evidencias de normas aceptadas o pendientes con su texto; el CSV solo sus versiones y fechas. No es una copia de seguridad ni acredita asistencia.",
              "JSON quenda.reservations, versión 3, ou unha táboa CSV cunha fila por reserva. Inclúe reservas que solapan o período, conservando os seus intervalos completos. O JSON engade evidencias de normas aceptadas ou pendentes co seu texto; o CSV só as súas versións e datas. Non é unha copia de seguridade nin acredita asistencia.",
            )
          : t(
              "Los indicadores describen reservas, no asistencia. El total municipal incluye unidades retiradas y calcula la ocupación sobre la suma de minutos, no sobre la media de porcentajes.",
              "Os indicadores describen reservas, non asistencia. O total municipal inclúe unidades retiradas e calcula a ocupación sobre a suma de minutos, non sobre a media de porcentaxes.",
            )}
      </p>
      <div
        onChange={() => {
          setResult(undefined);
          setAnalytics(undefined);
          setScope(undefined);
          setDownload(false);
        }}
      >
        <ActionForm
          label={
            exporting
              ? format === "csv"
                ? t("Descargar CSV", "Descargar CSV")
                : t("Descargar JSON", "Descargar JSON")
              : t("Consultar indicadores", "Consultar indicadores")
          }
          resetOnSuccess={false}
          submit={async (d) => {
            setResult(undefined);
            setAnalytics(undefined);
            setScope(undefined);
            setDownload(false);
            const from = textField(d, "from"),
              to = textField(d, "to"),
              unitId =
                textField(d, "scope") === "unit"
                  ? textField(d, "unitId").trim().toLowerCase()
                  : null;
            if (!validPeriod(from, to) || unitId === "")
              throw new ApiError(
                400,
                "INVALID_INPUT",
                t(
                  "Selecciona un ámbito y un periodo válido de hasta 366 días.",
                  "Selecciona un ámbito e un período válido de ata 366 días.",
                ),
              );
            if (
              !(exporting
                ? canExport(m, unitId)
                : allowed(m, "REPORT_READ", unitId))
            )
              throw new ApiError(
                403,
                "FORBIDDEN",
                t(
                  "No tienes permisos para este ámbito.",
                  "Non tes permisos para este ámbito.",
                ),
              );
            const params = new URLSearchParams({ from, to });
            if (exporting) {
              if (unitId) params.set("unitId", unitId);
              if (format === "csv") {
                params.set("format", "csv");
                saveFile(
                  "quenda-reservations-v3.csv",
                  await api<string>(
                    `${endpoint(m.id)}/exports/reservations?${params}`,
                    { signal: AbortSignal.timeout(60_000) },
                    locale,
                  ),
                  "text/csv;charset=utf-8",
                );
              } else
                saveFile(
                  "quenda-reservations-v3.json",
                  JSON.stringify(
                    await api(
                      `${endpoint(m.id)}/exports/reservations?${params}`,
                      { signal: AbortSignal.timeout(60_000) },
                      locale,
                    ),
                    null,
                    2,
                  ),
                  "application/json",
                );
              setDownload(true);
            } else {
              const scoped = new URLSearchParams(params);
              if (unitId) scoped.set("unitId", unitId);
              setResult(
                await api<Indicators>(
                  `${endpoint(m.id)}${unitId ? `/units/${encodeURIComponent(unitId)}` : ""}/indicators?${params}`,
                  { signal: AbortSignal.timeout(60_000) },
                  locale,
                ),
              );
              setScope(scoped.toString());
            }
          }}
        >
          <ScopeField exporting={exporting} />
          <PeriodFields />
          {exporting && (
            <>
              <Select
                label={t("Formato", "Formato")}
                value={format}
                onValueChange={(value) => setFormat(value as "json" | "csv")}
                options={[
                  { value: "json", label: "JSON (quenda.reservations v3)" },
                  {
                    value: "csv",
                    label: t(
                      "CSV para hojas de cálculo",
                      "CSV para follas de cálculo",
                    ),
                  },
                ]}
              />
              <p>
                {t(
                  "Incluye identificadores de titulares, no nombres, correos ni credenciales. Más de 10.000 reservas se rechazan sin archivo parcial: reduce el periodo o elige una unidad.",
                  "Inclúe identificadores de titulares, non nomes, correos nin credenciais. Máis de 10.000 reservas rexéitanse sen arquivo parcial: reduce o período ou escolle unha unidade.",
                )}
              </p>
              <Checkbox
                required
                label={t(
                  "Confirmo la descarga de datos del ámbito autorizado",
                  "Confirmo a descarga de datos do ámbito autorizado",
                )}
              />
            </>
          )}
        </ActionForm>
      </div>
      {download && (
        <p role="status">
          {t(
            "Archivo preparado para descargar.",
            "Arquivo preparado para descargar.",
          )}
        </p>
      )}
      {result && (
        <section
          aria-label={t("Resultado de indicadores", "Resultado de indicadores")}
        >
          <h2>
            {result.unitId
              ? t("Unidad reservable", "Unidade reservable")
              : m.name}
          </h2>
          {result.unitId && <p>{result.unitId}</p>}
          <p>
            {result.from} — {result.to} · {result.timeZone}
          </p>
          <p>
            {t("Consulta", "Consulta")}:{" "}
            {new Date(result.asOf).toLocaleString(
              locale === "gl" ? ["gl-ES", "es-ES"] : "es-ES",
            )}
          </p>
          <div className={styles.metrics}>
            {(
              [
                ["CONFIRMADA", t("Confirmadas", "Confirmadas")],
                ["CANCELADA", t("Canceladas", "Canceladas")],
                ["FINALIZADA", t("Finalizadas", "Finalizadas")],
              ] as const
            ).map(([key, label]) => (
              <MetricCard
                key={key}
                label={label}
                value={result.reservations[key]}
                locale={locale}
                context={t(
                  "Reservas que empiezan en el periodo",
                  "Reservas que comezan no período",
                )}
              />
            ))}
            <MetricCard
              label={t("Minutos reservados", "Minutos reservados")}
              value={result.reservedMinutes}
              locale={locale}
              decimals={2}
              context={t(
                "Intersección de reservas confirmadas con el periodo",
                "Intersección de reservas confirmadas co período",
              )}
            />
            <MetricCard
              label={t("Minutos ofertados", "Minutos ofertados")}
              value={result.offeredMinutes}
              locale={locale}
              decimals={2}
              context={t(
                "Calendarios y cierres históricos",
                "Calendarios e peches históricos",
              )}
            />
            <MetricCard
              label={t("Ocupación reservada", "Ocupación reservada")}
              value={
                result.occupancyPercent ?? t("No aplicable", "Non aplicable")
              }
              locale={locale}
              decimals={2}
              suffix={result.occupancyPercent === null ? undefined : "%"}
              context={t(
                "Minutos reservados / minutos ofertados × 100",
                "Minutos reservados / minutos ofertados × 100",
              )}
            />
          </div>
        </section>
      )}
      {result && scope && !analytics && (
        <div className={styles.analysis}>
          <ActionForm
            label={t("Analizar el uso", "Analizar o uso")}
            resetOnSuccess={false}
            submit={async () =>
              setAnalytics(
                await api<UsageAnalytics>(
                  `${endpoint(m.id)}/analytics?${scope}`,
                  { signal: AbortSignal.timeout(60_000) },
                  locale,
                ),
              )
            }
          >
            <p>
              {t(
                "Ocupación por día y hora y por espacio, cancelaciones, antelación y llegadas registradas del mismo periodo y ámbito.",
                "Ocupación por día e hora e por espazo, cancelacións, antelación e chegadas rexistradas do mesmo período e ámbito.",
              )}
            </p>
          </ActionForm>
        </div>
      )}
      {result && analytics && <UsageAnalysis analytics={analytics} />}
    </div>
  );
}
