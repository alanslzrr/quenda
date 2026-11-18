import { useState } from "react";
import { ActionForm, textField } from "../../app/action";
import { api } from "../../app/api";
import { localDateTime } from "../../app/dates";
import { Disclosure } from "../../app/disclosure";
import { usePreferences } from "../../app/preferences-provider";
import { MetricCard } from "../../ui/metric-card/metric-card";
import { useAgreementOptions } from "../collaboration/agreement-select";
import { ManagementPage } from "../municipal/page";
import { Denied, endpoint, useMunicipality } from "../municipal/shared";
import { MonthlyFields, useReportAgreementsPath } from "./fields";
import { allowed, type Monthly, minuteDecimals, monthName } from "./model";
import styles from "./reporting.module.css";
export function MonthlyReport() {
  const m = useMunicipality();
  return allowed(m, "REPORT_READ", null) ? <Report key={m.id} /> : <Denied />;
}
function Report() {
  const m = useMunicipality(),
    { t, locale } = usePreferences();
  const [result, setResult] = useState<{
    report: Monthly;
    agreement: string;
    agreementName: string;
    month: string;
  }>();
  // Report readers choose among the agreements with aggregate reports in which the municipality participates.
  const { none } = useAgreementOptions(true, useReportAgreementsPath());
  return (
    <ManagementPage
      title={t("Informe conjunto mensual", "Informe conxunto mensual")}
      description={t(
        "Consulta el último informe autorizado para tu cuenta y municipio. Cada entrega se registra. No admite filtros adicionales ni selección de revisiones; las cifras describen reservas, no asistencia.",
        "Consulta o último informe autorizado para a túa conta e municipio. Cada entrega rexístrase. Non admite filtros adicionais nin selección de revisións; as cifras describen reservas, non asistencia.",
      )}
    >
      <div onChange={() => setResult(undefined)}>
        <ActionForm
          label={t("Consultar informe", "Consultar informe")}
          resetOnSuccess={false}
          unavailable={
            none
              ? t(
                  "Los informes conjuntos pertenecen a un convenio. Podrás consultarlos cuando el municipio participe en alguno activado con informes conjuntos.",
                  "Os informes conxuntos pertencen a un convenio. Poderás consultalos cando o municipio participe nalgún activado con informes conxuntos.",
                )
              : undefined
          }
          submit={async (d) => {
            setResult(undefined);
            const agreement = textField(d, "agreementId").trim().toLowerCase(),
              agreementName = textField(d, "agreementName"),
              month = textField(d, "month");
            const report = await api<Monthly>(
              `${endpoint(m.id)}/agreements/${encodeURIComponent(agreement)}/reports/${encodeURIComponent(month)}`,
              {},
              locale,
            );
            setResult({ report, agreement, agreementName, month });
          }}
        >
          <MonthlyFields />
        </ActionForm>
      </div>
      {result && (
        <section
          aria-label={t("Resultado del informe", "Resultado do informe")}
        >
          <p>
            {result.agreementName} · {monthName(result.month, locale)}
          </p>
          <Disclosure
            title={t("Identificador técnico", "Identificador técnico")}
          >
            <code>{result.agreement}</code>
          </Disclosure>
          {result.report.status === "NOT_PUBLISHABLE" ? (
            <h2>{t("No publicable", "Non publicable")}</h2>
          ) : (
            <>
              <h2>{t("Informe autorizado", "Informe autorizado")}</h2>
              <p>
                {t("Revisión", "Revisión")}: {result.report.revision} ·{" "}
                {t("Versión del control", "Versión do control")}:{" "}
                {result.report.controlVersion}
              </p>
              <p>
                {t("Corte", "Corte")}:{" "}
                {localDateTime(result.report.cutoff, locale)}
              </p>
              <div className={styles.metrics}>
                <MetricCard
                  label={t("Reservas confirmadas", "Reservas confirmadas")}
                  value={result.report.reservations}
                  locale={locale}
                  context={t("Inicio dentro del mes", "Inicio dentro do mes")}
                />
                <MetricCard
                  label={t("Minutos reservados", "Minutos reservados")}
                  value={result.report.reservedMinutes}
                  locale={locale}
                  decimals={minuteDecimals(result.report.reservedMinutes)}
                  context={t(
                    "Intersección con el mes del convenio",
                    "Intersección co mes do convenio",
                  )}
                />
              </div>
            </>
          )}
        </section>
      )}
    </ManagementPage>
  );
}
