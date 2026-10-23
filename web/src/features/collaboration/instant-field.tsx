import { useState } from "react";
import { usePreferences } from "../../app/preferences-provider";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { civilOptions, civilValue } from "./model";
export function InstantField({
  name,
  label,
  zone,
  initial,
}: {
  name: string;
  label: string;
  zone: string;
  initial?: string;
}) {
  const { t } = usePreferences();
  const [value, setValue] = useState(() =>
    initial ? civilValue(initial, zone) : "",
  );
  const [choice, setChoice] = useState(
    initial ? new Date(initial).toISOString() : "",
  );
  const options = civilOptions(value, zone);
  const utc =
    options.length === 1
      ? options[0].utc
      : (options.find((o) => o.utc === choice)?.utc ?? "");
  return (
    <div>
      <Input
        label={label}
        required
        type="datetime-local"
        step="0.001"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setChoice("");
        }}
      />
      <input type="hidden" name={name} value={utc} />
      {value && !options.length && (
        <p role="alert">
          {t(
            "La fecha, hora o zona no es válida. Las horas inexistentes no se ajustan automáticamente.",
            "A data, hora ou zona non é válida. As horas inexistentes non se axustan automaticamente.",
          )}
        </p>
      )}
      {options.length > 1 && (
        <Select
          label={`${label} · UTC`}
          value={choice}
          onValueChange={setChoice}
          placeholder={t("Selecciona el desfase", "Selecciona o desfase")}
          options={options.map((o) => ({
            value: o.utc,
            label: `UTC${o.offset}`,
          }))}
        />
      )}
    </div>
  );
}
