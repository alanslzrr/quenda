import { useState } from "react";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { AccountSelect } from "../municipal/account-select";
import {
  endpoint,
  More,
  useMunicipality,
  useMunicipalPages,
} from "../municipal/shared";
import { monthName } from "./model";

type ReviewOption = {
  month: string;
  revision: number;
  participants: { id: string; name: string }[];
};
export function ReviewFields({ agreement }: { agreement: string }) {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const [month, setMonth] = useState("");
  const [recipient, setRecipient] = useState(m.id);
  const query = useMunicipalPages<ReviewOption>(
    `${endpoint(m.id)}/agreements/${encodeURIComponent(agreement)}/review-options`,
  );
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = rows.find((row) => row.month === month);
  return (
    <>
      <Select
        name="month"
        required
        label={t("Mes preparado", "Mes preparado")}
        value={month}
        onValueChange={(value) => {
          setMonth(value);
          setRecipient(m.id);
        }}
        placeholder={t("Selecciona un mes", "Selecciona un mes")}
        options={rows.map((row) => ({
          value: row.month,
          label: `${monthName(row.month, locale)} · ${t("revisión", "revisión")} ${row.revision}`,
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
                "No hay informes preparados para revisar. La preparación debe realizarse antes de registrar una evaluación.",
                "Non hai informes preparados para revisar. A preparación debe realizarse antes de rexistrar unha avaliación.",
              )}
            </p>
          )}
        </>
      )}
      <input type="hidden" name="revision" value={selected?.revision ?? ""} />
      {selected && (
        <>
          <input
            type="hidden"
            name="recipientMunicipalityName"
            value={
              selected.participants.find((p) => p.id === recipient)?.name ?? ""
            }
          />

          <Select
            required
            name="recipientTenantId"
            label={t("Municipio destinatario", "Municipio destinatario")}
            value={recipient}
            onValueChange={setRecipient}
            options={selected.participants.map((p) => ({
              value: p.id,
              label:
                p.id === m.id
                  ? `${p.name} · ${t("este municipio", "este municipio")}`
                  : selected.participants.filter(
                        (other) => other.id !== m.id && other.name === p.name,
                      ).length > 1
                    ? `${p.name} · ${p.id}`
                    : p.name,
            }))}
          />
          {recipient === m.id ? (
            <AccountSelect
              key={`${month}:${recipient}`}
              name="recipientAccountId"
              label={t("Persona destinataria", "Persoa destinataria")}
            />
          ) : (
            <>
              <p>
                {t(
                  "No se consulta el directorio de otro municipio. Solicita al municipio destinatario la referencia de la cuenta para esta revisión.",
                  "Non se consulta o directorio doutro municipio. Solicita ao municipio destinatario a referencia da conta para esta revisión.",
                )}
              </p>
              <Input
                key={`${month}:${recipient}`}
                required
                name="recipientAccountId"
                maxLength={200}
                label={t(
                  "Referencia de cuenta facilitada por el destinatario",
                  "Referencia de conta facilitada polo destinatario",
                )}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
