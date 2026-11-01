import { useState } from "react";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Select } from "../../ui/select/select";
import { type AccountLabelValue, accountText } from "./account-label";
import { endpoint, More, useMunicipality, useMunicipalPages } from "./shared";

/** Only the current municipality's existing profiles. Never a global directory. */
export function AccountSelect({
  name = "accountId",
  label,
  value,
  onChange,
}: {
  name?: string;
  label: string;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [selected, setSelected] = useState("");
  const query = useMunicipalPages<{
    accountId: string;
    accountLabel?: AccountLabelValue;
  }>(`${endpoint(m.id)}/profiles`);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <input
        type="hidden"
        name={`${name}Label`}
        value={accountText(
          rows.find((row) => row.accountId === (value ?? selected))
            ?.accountLabel,
          t("Cuenta no disponible", "Conta non dispoñible"),
        )}
      />
      <Select
        name={name}
        required
        label={label}
        value={value ?? selected}
        onValueChange={onChange ?? setSelected}
        placeholder={t("Selecciona una cuenta", "Selecciona unha conta")}
        options={rows.map((row) => ({
          value: row.accountId,
          label: accountText(
            row.accountLabel,
            t("Cuenta no disponible", "Conta non dispoñible"),
          ),
          disabled: !row.accountLabel,
        }))}
      />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <More query={query} />
          {!rows.length && (
            <p>
              {t(
                "No hay cuentas vinculadas a este municipio.",
                "Non hai contas vinculadas a este municipio.",
              )}
            </p>
          )}
        </>
      )}
    </>
  );
}
