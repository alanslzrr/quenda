import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Select } from "../../ui/select/select";
import {
  endpoint,
  More,
  useMunicipality,
  useMunicipalPages,
} from "../municipal/shared";
import { agreementChoices } from "./model";

type AgreementOption = { agreementId: string; name: string; version: number };

/**
 * Agreements of the municipality; `none` only once every page has loaded empty. `path` narrows the source, such as
 * the agreements whose monthly report a REPORT_READ holder can request; it defaults to the administrator listing.
 */
export function useAgreementOptions(enabled = true, path?: string) {
  const m = useMunicipality();
  const query = useMunicipalPages<AgreementOption>(
    path ?? `${endpoint(m.id)}/agreements`,
    enabled,
  );
  const agreements = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.items) ?? []).map((a) => [
        a.agreementId,
        a,
      ]),
    ).values(),
  ];
  return {
    query,
    agreements,
    none: query.isSuccess && !query.hasNextPage && !agreements.length,
  };
}
export function AgreementSelect({
  value,
  onChange,
  path,
  empty,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Source listing; see useAgreementOptions. */
  path?: string;
  /** Shown when the source lists no agreement. */
  empty?: string;
}) {
  const { t } = usePreferences();
  const { query, agreements } = useAgreementOptions(true, path);
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
          ...agreementChoices(agreements),
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
              {empty ??
                t(
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
