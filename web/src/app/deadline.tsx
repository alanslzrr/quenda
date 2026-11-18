import { useState } from "react";
import { localInstants } from "../features/municipal/local-instants";
import { Select } from "../ui/select/select";
import { useFieldErrorAnnouncement } from "./announce";
import { DateTimeField } from "./date-fields";
import styles from "./date-fields.module.css";
import { usePreferences } from "./preferences-provider";
export function Deadline({
  name,
  label,
  required = false,
  onValueChange,
}: {
  name: string;
  label: string;
  required?: boolean;
  /** The local date and time as entered, empty while unset. */
  onValueChange?: (value: string) => void;
}) {
  const { t } = usePreferences();
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState("");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const instants = localInstants(value, zone);
  const utc =
    instants.length === 1
      ? instants[0].utc
      : (instants.find((x) => x.utc === choice)?.utc ?? "");
  const error =
    value && !instants.length
      ? t(
          "Esta hora no existe en la zona indicada.",
          "Esta hora non existe na zona indicada.",
        )
      : undefined;
  const announceError = useFieldErrorAnnouncement(label, error);
  return (
    <div className={styles.stack}>
      <DateTimeField
        label={label}
        value={value}
        required={required}
        error={error}
        onBlur={announceError}
        onValueChange={(next) => {
          setValue(next);
          setChoice("");
          onValueChange?.(next);
        }}
      />
      <input type="hidden" name={name} value={utc} />
      <input type="hidden" name={`${name}Entered`} value={value} />
      {instants.length > 1 && (
        <Select
          label={`${label} · UTC`}
          value={choice}
          placeholder={t("Selecciona el desfase", "Selecciona o desfase")}
          onValueChange={setChoice}
          options={instants.map((x) => ({
            value: x.utc,
            label: `UTC${x.offset}`,
          }))}
        />
      )}
    </div>
  );
}
