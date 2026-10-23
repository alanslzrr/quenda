import { useState } from "react";
import { ActionForm, textField } from "../../app/action";
import { ApiError, api } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { MetricCard } from "../../ui/metric-card/metric-card";
import { Denied, endpoint, useMunicipality } from "../municipal/shared";
import { PeriodFields, ScopeField } from "./fields";
import {
  allowed,
  canEnter,
  canExport,
  type Indicators,
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
  const [download, setDownload] = useState(false);
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
              "JSON quenda.reservations, versión 3. Incluye reservas que solapan el periodo, conservando sus intervalos completos y evidencias de normas aceptadas o pendientes. No es una copia de seguridad ni acredita asistencia.",
              "JSON quenda.reservations, versión 3. Inclúe reservas que solapan o período, conservando os seus intervalos completos e evidencias de normas aceptadas ou pendentes. Non é unha copia de seguridade nin acredita asistencia.",
            )
          : t(
              "Los indicadores describen reservas, no asistencia. El total municipal incluye unidades retiradas y calcula la ocupación sobre la suma de minutos, no sobre la media de porcentajes.",
              "Os indicadores describen reservas, non asistencia. O total municipal inclúe unidades retiradas e calcula a ocupación sobre a suma de minutos, non sobre a media de porcentaxes.",
            )}
      </p>
      <div
        onChange={() => {
          setResult(undefined);
          setDownload(false);
        }}
      >
        <ActionForm
          label={
            exporting
              ? t("Descargar JSON", "Descargar JSON")
              : t("Consultar indicadores", "Consultar indicadores")
          }
          resetOnSuccess={false}
          submit={async (d) => {
            setResult(undefined);
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
              const payload = await api(
                `${endpoint(m.id)}/exports/reservations?${params}`,
                {},
                locale,
              );
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(payload, null, 2)], {
                  type: "application/json",
                }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "quenda-reservations-v3.json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setDownload(true);
            } else
              setResult(
                await api<Indicators>(
                  `${endpoint(m.id)}${unitId ? `/units/${encodeURIComponent(unitId)}` : ""}/indicators?${params}`,
                  {},
                  locale,
                ),
              );
          }}
        >
          <ScopeField exporting={exporting} />
          <PeriodFields />
          {exporting && (
            <>
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
            {new Date(result.asOf).toLocaleString(locale)}
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
    </div>
  );
}
