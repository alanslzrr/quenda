import { useState } from "react";
import { usePreferences } from "../../app/preferences-provider";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { AccountSelect } from "../municipal/account-select";
import { Reason } from "../municipal/shared";
import { usePrivacyScope } from "./context";
import { accountKeyedFamily, type Category, families } from "./model";
export function CategoryField({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value: string) => void;
} = {}) {
  const { global } = usePrivacyScope();
  const { locale, t } = usePreferences();
  const [own, setOwn] = useState("");
  const selected = value ?? own;
  const setSelected = onChange ?? setOwn;
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
/**
 * The account a privacy form refers to. An actor who is also an administrator
 * of this municipality may pick it among the people linked to it, a list that
 * role already reads; otherwise, and always in the global scope, the exact
 * identifier is typed. A privacy permission alone never opens that list.
 */
export function SubjectField({
  name,
  label,
  maxLength = 128,
  value,
  onChange,
}: {
  name: string;
  /** Label of the exact identifier field. */
  label: string;
  maxLength?: number;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const { directory, global } = usePrivacyScope();
  const { t } = usePreferences();
  const [mode, setMode] = useState(directory ? "directory" : "exact");
  const listed = directory && mode === "directory";
  return (
    <>
      {directory && (
        <Select
          label={t("Cómo indicar la cuenta", "Como indicar a conta")}
          value={mode}
          onValueChange={(next) => {
            setMode(next);
            onChange?.("");
          }}
          options={[
            {
              value: "directory",
              label: t(
                "Elegir entre las personas vinculadas al municipio",
                "Escoller entre as persoas vinculadas ao municipio",
              ),
            },
            {
              value: "exact",
              label: t(
                "Escribir el identificador exacto",
                "Escribir o identificador exacto",
              ),
            },
          ]}
        />
      )}
      {listed ? (
        <AccountSelect
          key="directory"
          name={name}
          label={t("Persona vinculada", "Persoa vinculada")}
          value={value}
          onChange={onChange}
        />
      ) : (
        <Input
          key="exact"
          required
          name={name}
          maxLength={maxLength}
          label={label}
          value={value}
          onChange={onChange && ((e) => onChange(e.target.value))}
        />
      )}
      {!directory && (
        <p>
          {global
            ? t(
                "No existe un directorio global de cuentas: indica el identificador exacto que consta en la solicitud o en el expediente.",
                "Non existe un directorio global de contas: indica o identificador exacto que consta na solicitude ou no expediente.",
              )
            : t(
                "El permiso de privacidad no da acceso al listado de personas del municipio, que corresponde a su administración: indica el identificador exacto.",
                "O permiso de privacidade non dá acceso á listaxe de persoas do municipio, que corresponde á súa administración: indica o identificador exacto.",
              )}
        </p>
      )}
    </>
  );
}
export function TargetField({ category }: { category?: string } = {}) {
  const { t } = usePreferences();
  const { directory } = usePrivacyScope();
  if (directory && category && accountKeyedFamily(category))
    return (
      <SubjectField
        key={category}
        name="targetKey"
        maxLength={500}
        label={t("Referencia del registro", "Referencia do rexistro")}
      />
    );
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
