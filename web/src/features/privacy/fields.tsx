import { useState } from "react";
import { usePreferences } from "../../app/preferences-provider";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { Reason } from "../municipal/shared";
import { usePrivacyScope } from "./context";
import { type Category, families } from "./model";
export function CategoryField() {
  const { global } = usePrivacyScope();
  const { locale, t } = usePreferences();
  const [selected, setSelected] = useState("");
  const anchors: Record<Category, string> = {
    COMMUNICATIONS: t(
      "Cómputo desde la última actividad del evento, aviso, correo e intentos.",
      "Cómputo desde a última actividade do evento, aviso, correo e intentos.",
    ),
    RESERVATIONS: t(
      "Cómputo desde el fin de la reserva o su último evento, el posterior.",
      "Cómputo desde o fin da reserva ou o seu último evento, o posterior.",
    ),
    MUNICIPAL_PROFILE: t(
      "Cómputo desde la última actividad municipal conservada. Suprimir el perfil no cierra la cuenta global.",
      "Cómputo desde a última actividade municipal conservada. Suprimir o perfil non pecha a conta global.",
    ),
    AUTHORITY: t(
      "Permisos retirados o vencidos: último hecho del conjunto. Los accesos de privacidad se tratan por evento.",
      "Permisos retirados ou vencidos: último feito do conxunto. Os accesos de privacidade trátanse por evento.",
    ),
    ACCREDITATIONS: t(
      "Cómputo desde la revocación, si existe, o el fin de vigencia. Se protegen las referencias compartidas.",
      "Cómputo desde a revogación, se existe, ou o fin de vixencia. Protéxense as referencias compartidas.",
    ),
    AUTHENTICATION: t(
      "Cómputo desde el evento de seguridad o el vencimiento del artefacto técnico; no elimina credenciales activas por antigüedad.",
      "Cómputo desde o evento de seguridade ou o vencemento do artefacto técnico; non elimina credenciais activas por antigüidade.",
    ),
    IDENTITY: t(
      "Cómputo desde la baja voluntaria. La supresión impide reactivar la identidad y respeta las evidencias dependientes.",
      "Cómputo desde a baixa voluntaria. A supresión impide reactivar a identidade e respecta as evidencias dependentes.",
    ),
  };
  return (
    <Select
      name="category"
      value={selected}
      onValueChange={setSelected}
      description={anchors[selected as Category]}
      required
      label={t("Familia de datos", "Familia de datos")}
      placeholder={t("Selecciona una familia", "Selecciona unha familia")}
      options={families
        .filter((f) => (global ? f.global : f.municipal))
        .map((f) => ({ value: f.value, label: f[locale] }))}
    />
  );
}
export function ActionFields() {
  const { t } = usePreferences();
  const [action, setAction] = useState("");
  return (
    <>
      <Select
        required
        name="action"
        label={t("Actuación", "Actuación")}
        value={action}
        onValueChange={setAction}
        placeholder={t("Selecciona una actuación", "Selecciona unha actuación")}
        options={[
          { value: "ERASE", label: t("Suprimir", "Suprimir") },
          {
            value: "BLOCK",
            label: t(
              "Bloquear y conservar restringido",
              "Bloquear e conservar restrinxido",
            ),
          },
        ]}
      />
      {action === "BLOCK" && (
        <Input
          name="blockDays"
          required
          type="number"
          min={1}
          max={365000}
          step={1}
          label={t(
            "Duración autorizada del archivo bloqueado (días)",
            "Duración autorizada do arquivo bloqueado (días)",
          )}
        />
      )}
      <p>
        {t(
          "Suprimir retira el conjunto operativo. Bloquear lo retira del uso ordinario y conserva un archivo restringido hasta su destrucción autorizada. Esta interfaz no permite consultar ese archivo.",
          "Suprimir retira o conxunto operativo. Bloquear retírao do uso ordinario e conserva un arquivo restrinxido ata a súa destrución autorizada. Esta interface non permite consultar ese arquivo.",
        )}
      </p>
    </>
  );
}
export function Authorization() {
  const { t } = usePreferences();
  return (
    <>
      <Input
        required
        name="authorizationReference"
        maxLength={500}
        label={t("Referencia de autorización", "Referencia de autorización")}
      />
      <Reason />
    </>
  );
}
export function TargetField() {
  const { t } = usePreferences();
  return (
    <>
      <Input
        required
        name="targetKey"
        maxLength={500}
        label={t("Referencia del registro", "Referencia do rexistro")}
      />
      <p>
        {t(
          "Utiliza la referencia exacta del conjunto autorizado, correspondiente a su familia y ámbito. No se admiten consultas ni filtros libres.",
          "Utiliza a referencia exacta do conxunto autorizado, correspondente á súa familia e ámbito. Non se admiten consultas nin filtros libres.",
        )}
      </p>
    </>
  );
}
