import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Select } from "../../ui/select/select";
import {
  endpoint,
  More,
  useMunicipality,
  useMunicipalPages,
} from "../municipal/shared";
import type { AgreementSummary } from "./model";

export function AgreementSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const query = useMunicipalPages<AgreementSummary>(
    `${endpoint(m.id)}/agreements`,
  );
  const agreements = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.items) ?? []).map((a) => [
        a.agreementId,
        a,
      ]),
    ).values(),
  ];
  return (
    <>
      <input
        type="hidden"
        name="agreementName"
        value={
          agreements.find((a) => a.agreementId === value)?.name ??
          t("Convenio seleccionado", "Convenio seleccionado")
        }
      />
      <Select
        name="agreementId"
        required
        label={t("Convenio", "Convenio")}
        placeholder={t("Selecciona un convenio", "Selecciona un convenio")}
        value={value}
        onValueChange={onChange}
        options={[
          ...(value && !agreements.some((a) => a.agreementId === value)
            ? [
                {
                  value,
                  label: t(
                    "Convenio del enlace · carga más para ver su nombre",
                    "Convenio da ligazón · carga máis para ver o seu nome",
                  ),
                },
              ]
            : []),
          ...agreements.map((a) => ({ value: a.agreementId, label: a.name })),
        ]}
      />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <More query={query} />
          {!agreements.length && (
            <p>
              {t(
                "No hay convenios disponibles en este municipio.",
                "Non hai convenios dispoñibles neste municipio.",
              )}
            </p>
          )}
        </>
      )}
    </>
  );
}
