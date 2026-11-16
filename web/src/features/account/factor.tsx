import { useState } from "react";
import { textField } from "../../app/action";
import { api } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";

// The second-factor step is shared by sign-in, recovery and the session dialog in the eager layout,
// so it lives apart from the lazily routed security page and its dependencies.
export function FactorField({
  optional = false,
  focus = false,
}: {
  optional?: boolean;
  /** Moves focus to the code field, for a step the person just reached. */
  focus?: boolean;
}) {
  const { t } = usePreferences();
  const [backup, setBackup] = useState(false);
  return (
    <>
      <Checkbox
        label={t("Usar un código de respaldo", "Usar un código de respaldo")}
        checked={backup}
        onCheckedChange={(value) => setBackup(value === true)}
      />
      <Input
        key={String(backup)}
        name={backup ? "backupCode" : "totpCode"}
        label={
          backup
            ? t("Código de respaldo", "Código de respaldo")
            : t("Código de autenticación", "Código de autenticación")
        }
        required={!optional}
        autoFocus={focus}
        autoComplete="one-time-code"
        inputMode={backup ? "text" : "numeric"}
        pattern={backup ? "[A-Za-z0-9]{5}-[A-Za-z0-9]{5}" : "[0-9]{6}"}
        maxLength={backup ? 11 : 6}
      />
    </>
  );
}
export function factorProof(data: FormData) {
  const backupCode = textField(data, "backupCode");
  const totpCode = textField(data, "totpCode");
  return backupCode ? { backupCode } : totpCode ? { totpCode } : {};
}
export async function verifyFactor(data: FormData, locale: "es" | "gl") {
  const backup = textField(data, "backupCode");
  await api(
    `/api/auth/two-factor/${backup ? "verify-backup-code" : "verify-totp"}`,
    {
      method: "POST",
      body: JSON.stringify({
        code: backup || textField(data, "totpCode"),
        trustDevice: false,
      }),
    },
    locale,
  );
}
