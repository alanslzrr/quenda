import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { localInstants } from "./local-instants";
import styles from "./municipal.module.css";
import {
  endpoint,
  More,
  MunicipalForm,
  Reason,
  useMunicipality,
  useMunicipalPages,
} from "./shared";
import staffStyles from "./staff.module.css";
import {
  municipalOnly,
  type Operation,
  type Permission,
  type StaffInvitation,
  staffOperations,
  validPermissions,
} from "./staff-model";

export function useAuthoritySaved() {
  const client = useQueryClient();
  const { account } = useSession();
  const navigate = useNavigate();
  return async (leave = false) => {
    if (leave) navigate("/administracion", { replace: true });
    await Promise.all(
      ["navigation", "municipal-context", "invitations"].map((key) =>
        client.invalidateQueries({
          queryKey: ["private", account?.accountId, key],
        }),
      ),
    );
  };
}
function Deadline({
  name,
  label,
  required = false,
}: {
  name: string;
  label: string;
  required?: boolean;
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
  return (
    <div>
      <Input
        label={label}
        type="datetime-local"
        value={value}
        required={required}
        onChange={(e) => {
          setValue(e.target.value);
          setChoice("");
        }}
      />
      <input type="hidden" name={name} value={utc} />
      <input type="hidden" name={`${name}Entered`} value={value} />
      {value && !instants.length && (
        <p role="alert">
          {t(
            "Esta hora no existe en la zona indicada.",
            "Esta hora non existe na zona indicada.",
          )}
        </p>
      )}
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
function PermissionEditor({
  value,
  onChange,
}: {
  value: Permission[];
  onChange: (value: Permission[]) => void;
}) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const units = useMunicipalPages<{ id: string; name: string }>(
    `${endpoint(m.id)}/agenda/units`,
  );
  const [operation, setOperation] = useState<Operation>("RESERVATION_READ");
  const [scope, setScope] = useState("municipal");
  const unitId =
    municipalOnly(operation) || scope === "municipal" ? null : scope;
  const duplicate = value.some(
    (p) => p.operation === operation && p.unitId === unitId,
  );
  const all = units.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <fieldset className={staffStyles.permissions}>
      <legend>{t("Permisos", "Permisos")}</legend>
      <p>
        {t(
          "Cada permiso es independiente. Los de privacidad requieren concesión expresa, también para administradores.",
          "Cada permiso é independente. Os de privacidade requiren concesión expresa, tamén para administradores.",
        )}
      </p>
      <ul>
        {value.map((p, index) => (
          <li key={`${p.operation}:${p.unitId}`}>
            {t(...staffOperations[p.operation])} ·{" "}
            {p.unitId
              ? (all.find((u) => u.id === p.unitId)?.name ?? p.unitId)
              : t("Todo el municipio", "Todo o municipio")}{" "}
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              aria-label={`${t("Quitar permiso", "Quitar permiso")} ${index + 1}`}
            >
              {t("Quitar", "Quitar")}
            </Button>
          </li>
        ))}
      </ul>
      <Select
        label={t("Operación", "Operación")}
        value={operation}
        onValueChange={(v) => {
          setOperation(v as Operation);
          setScope("municipal");
        }}
        options={Object.entries(staffOperations).map(([value, labels]) => ({
          value,
          label: t(...labels),
        }))}
      />
      <Select
        label={t("Ámbito", "Ámbito")}
        value={municipalOnly(operation) ? "municipal" : scope}
        disabled={municipalOnly(operation)}
        onValueChange={setScope}
        options={[
          {
            value: "municipal",
            label: t("Todo el municipio", "Todo o municipio"),
          },
          ...all.map((u) => ({ value: u.id, label: u.name })),
        ]}
      />
      {units.isPending ? (
        <Loading />
      ) : units.isError ? (
        <Failure error={units.error} retry={() => void units.refetch()} />
      ) : (
        <More query={units} />
      )}
      <Button
        type="button"
        variant="secondary"
        disabled={duplicate || value.length >= 50}
        onClick={() => onChange([...value, { operation, unitId }])}
      >
        {t("Añadir permiso", "Engadir permiso")}
      </Button>
    </fieldset>
  );
}
export function StaffInvite({
  replacement,
  onSaved,
}: {
  replacement?: StaffInvitation;
  onSaved?: () => void;
}) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [kind, setKind] = useState("manager");
  const [permissions, setPermissions] = useState<Permission[]>(
    replacement?.permissions ?? [],
  );
  const [generation, setGeneration] = useState(0);
  const [created, setCreated] = useState(false);
  const actualKind = replacement ? "manager" : kind;
  const invalid = () =>
    new ApiError(
      400,
      "INVALID_INPUT",
      t(
        "Revisa los permisos y las fechas. Selecciona un desfase si la hora se repite.",
        "Revisa os permisos e as datas. Selecciona un desfase se a hora se repite.",
      ),
    );
  return (
    <>
      <p>
        {t(
          "La cuenta debe existir. El destinatario consulta y acepta la invitación desde su perfil con MFA; enviarla no activa permisos.",
          "A conta debe existir. O destinatario consulta e acepta a invitación desde o seu perfil con MFA; enviala non activa permisos.",
        )}
      </p>
      {replacement && (
        <p className={styles.notice}>
          {t(
            "La concesión anterior sigue vigente hasta aceptar la sustitución. Las demás concesiones no cambian. Para retirar acceso inmediatamente, revócala.",
            "A concesión anterior segue vixente ata aceptar a substitución. As demais concesións non cambian. Para retirar acceso inmediatamente, revógaa.",
          )}
        </p>
      )}
      {!replacement && (
        <Select
          label={t("Tipo de invitación", "Tipo de invitación")}
          value={kind}
          onValueChange={(value) => {
            setKind(value);
            setCreated(false);
          }}
          options={[
            {
              value: "manager",
              label: t("Gestor municipal", "Xestor municipal"),
            },
            {
              value: "administrator",
              label: t("Administrador municipal", "Administrador municipal"),
            },
          ]}
        />
      )}
      {created && (
        <p role="status">
          {t(
            "Invitación registrada. El destinatario debe aceptarla.",
            "Invitación rexistrada. O destinatario debe aceptala.",
          )}
        </p>
      )}
      <MunicipalForm
        key={`${actualKind}:${generation}`}
        path={`${endpoint(m.id)}/${actualKind}-invitations`}
        label={
          replacement
            ? t("Invitar con nuevos permisos", "Invitar con novos permisos")
            : t("Enviar invitación", "Enviar invitación")
        }
        body={(data) => {
          setCreated(false);
          const expiresAt = textField(data, "expiresAt"),
            roleExpiresAt = textField(data, "roleExpiresAt");
          if (
            !expiresAt ||
            Date.parse(expiresAt) <= Date.now() ||
            (textField(data, "roleExpiresAtEntered") &&
              (!roleExpiresAt || Date.parse(roleExpiresAt) <= Date.now())) ||
            (actualKind === "manager" && !validPermissions(permissions))
          )
            throw invalid();
          return {
            accountId:
              replacement?.accountId ?? textField(data, "accountId").trim(),
            expiresAt,
            roleExpiresAt: roleExpiresAt || null,
            ...(actualKind === "manager" ? { permissions } : {}),
            ...(replacement
              ? {
                  replacesInvitationId: replacement.invitationId,
                  reason: textField(data, "reason").trim(),
                }
              : {}),
          };
        }}
        onSaved={() => {
          setCreated(true);
          if (!replacement) {
            setPermissions([]);
            setGeneration((x) => x + 1);
          }
          onSaved?.();
        }}
      >
        <Input
          label={t("Identificador de cuenta", "Identificador de conta")}
          name="accountId"
          required
          maxLength={128}
          defaultValue={replacement?.accountId}
          readOnly={!!replacement}
        />
        <p>
          {t(
            "El usuario puede consultar su identificador en los datos de su cuenta. No se busca por correo ni se consulta un directorio global.",
            "O usuario pode consultar o seu identificador nos datos da súa conta. Non se busca por correo nin se consulta un directorio global.",
          )}
        </p>
        <p>
          {t("Zona horaria", "Zona horaria")}:{" "}
          {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </p>
        <Deadline
          name="expiresAt"
          label={t("Aceptar antes de", "Aceptar antes de")}
          required
        />
        <Deadline
          name="roleExpiresAt"
          label={t(
            "Permiso válido hasta (opcional)",
            "Permiso válido ata (opcional)",
          )}
        />
        <p>
          {t(
            "Sin fecha de permiso: no caduca automáticamente, pero puede revocarse. El plazo para aceptar es independiente.",
            "Sen data de permiso: non caduca automaticamente, pero pode revogarse. O prazo para aceptar é independente.",
          )}
        </p>
        {actualKind === "manager" ? (
          <PermissionEditor value={permissions} onChange={setPermissions} />
        ) : (
          <p className={styles.notice}>
            {t(
              "La administración permite configurar el municipio y asignar permisos. No incluye permisos de privacidad.",
              "A administración permite configurar o municipio e asignar permisos. Non inclúe permisos de privacidade.",
            )}
          </p>
        )}
        {replacement && <Reason />}
        <Checkbox
          required
          label={t(
            "Confirmo la cuenta, el alcance y la vigencia",
            "Confirmo a conta, o alcance e a vixencia",
          )}
        />
      </MunicipalForm>
    </>
  );
}
