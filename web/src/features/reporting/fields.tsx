import { useState } from "react";
import { usePreferences } from "../../app/preferences-provider";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { AgreementSelect } from "../collaboration/agreement-select";
import { useMunicipality } from "../municipal/shared";
import { allowed, canExport } from "./model";
export const uuidPattern =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export function ScopeField({ exporting = false }: { exporting?: boolean }) {
  const m = useMunicipality(),
    { t } = usePreferences();
  const permits = (unit: string | null) =>
    exporting ? canExport(m, unit) : allowed(m, "REPORT_READ", unit);
  const municipal = permits(null),
    [scope, setScope] = useState(municipal ? "municipal" : "unit");
  const known = [
    ...new Set(
      m.permissions.map((p) => p.unitId).filter((p): p is string => p !== null),
    ),
  ].filter(permits);
  return (
    <>
      <Select
        name="scope"
        label={t("Ámbito", "Ámbito")}
        value={scope}
        onValueChange={setScope}
        options={[
          ...(municipal
            ? [
                {
                  value: "municipal",
                  label: t("Todo el municipio", "Todo o municipio"),
                },
              ]
            : []),
          {
            value: "unit",
            label: t("Una unidad reservable", "Unha unidade reservable"),
          },
        ]}
      />
      {scope === "unit" &&
        (municipal ? (
          <Input
            name="unitId"
            label={t("Identificador de unidad", "Identificador de unidade")}
            required
            pattern={uuidPattern}
          />
        ) : (
          <Select
            name="unitId"
            required
            label={t("Unidad autorizada", "Unidade autorizada")}
            options={known.map((id) => ({ value: id, label: id }))}
          />
        ))}
      {scope === "unit" && (
        <p>
          {t(
            "Utiliza el identificador de la unidad, también si está retirada. No se limita la consulta al catálogo público.",
            "Utiliza o identificador da unidade, tamén se está retirada. Non se limita a consulta ao catálogo público.",
          )}
        </p>
      )}
    </>
  );
}
export function PeriodFields() {
  const { t } = usePreferences();
  return (
    <>
      <Input
        name="from"
        type="date"
        required
        label={t("Desde (incluido)", "Desde (incluído)")}
      />
      <Input
        name="to"
        type="date"
        required
        label={t("Hasta (excluido)", "Ata (excluído)")}
      />
      <p>
        {t(
          "Fechas locales del municipio. El último día no se incluye; máximo 366 días.",
          "Datas locais do municipio. O último día non se inclúe; máximo 366 días.",
        )}
      </p>
    </>
  );
}
export function MonthlyFields() {
  const m = useMunicipality();
  const [agreement, setAgreement] = useState("");
  const { t } = usePreferences();
  return (
    <>
      {m.administrator ? (
        <AgreementSelect value={agreement} onChange={setAgreement} />
      ) : (
        <Input
          name="agreementId"
          label={t("Identificador del convenio", "Identificador do convenio")}
          required
          pattern={uuidPattern}
        />
      )}
      <Input
        name="month"
        type="month"
        required
        label={t("Mes publicado", "Mes publicado")}
      />
    </>
  );
}
