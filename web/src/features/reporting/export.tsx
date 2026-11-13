import { useState } from "react";
import { ActionForm, textField } from "../../app/action";
import { ApiError, api } from "../../app/api";
import { saveFile } from "../../app/download";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Select } from "../../ui/select/select";
import { ManagementPage } from "../municipal/page";
import { Denied, endpoint, useMunicipality } from "../municipal/shared";
import { PeriodFields, ScopeField } from "./fields";
import { canEnter, canExport, validPeriod } from "./model";
import styles from "./reporting.module.css";
/** Reservation export, one row per reservation; usage analysis has its own screen. */
export function ReservationExport() {
  const m = useMunicipality();
  return canEnter(m, true) ? <Export key={m.id} /> : <Denied />;
}
function Export() {
  const m = useMunicipality(),
    { t, locale } = usePreferences();
  const [download, setDownload] = useState(false);
  const [format, setFormat] = useState<"json" | "csv">("json");
  return (
    <ManagementPage
      title={t("Exportar reservas", "Exportar reservas")}
      description={t(
        "Una hoja de cálculo con una fila por reserva, o los datos completos para otros sistemas.",
        "Unha folla de cálculo cunha fila por reserva, ou os datos completos para outros sistemas.",
      )}
    >
      <div onChange={() => setDownload(false)}>
        <ActionForm
          label={
            format === "csv"
              ? t("Descargar hoja de cálculo", "Descargar folla de cálculo")
              : t("Descargar datos completos", "Descargar datos completos")
          }
          resetOnSuccess={false}
          submit={async (d) => {
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
            if (!canExport(m, unitId))
              throw new ApiError(
                403,
                "FORBIDDEN",
                t(
                  "No tienes permisos para este ámbito.",
                  "Non tes permisos para este ámbito.",
                ),
              );
            const params = new URLSearchParams({ from, to });
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
          }}
        >
          <ScopeField exporting />
          <PeriodFields />
          <Select
            label={t("Formato", "Formato")}
            value={format}
            onValueChange={(value) => setFormat(value as "json" | "csv")}
            options={[
              {
                value: "json",
                label: t(
                  "Datos completos para otros sistemas",
                  "Datos completos para outros sistemas",
                ),
              },
              {
                value: "csv",
                label: t("Hoja de cálculo", "Folla de cálculo"),
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
      <p className={styles.note}>
        {t(
          "Incluye las reservas que coinciden con el periodo, con su horario completo. Los datos completos añaden el texto de las normas aceptadas o pendientes; la hoja de cálculo, solo sus versiones y fechas. No es una copia de seguridad ni acredita asistencia.",
          "Inclúe as reservas que coinciden co período, co seu horario completo. Os datos completos engaden o texto das normas aceptadas ou pendentes; a folla de cálculo, só as súas versións e datas. Non é unha copia de seguridade nin acredita asistencia.",
        )}
      </p>
    </ManagementPage>
  );
}
