import { Deadline } from "../../app/deadline";
import { usePreferences } from "../../app/preferences-provider";
import { Input } from "../../ui/input/input";
export function AccountField() {
  const { t } = usePreferences();
  return (
    <>
      <Input
        label={t("Identificador de cuenta", "Identificador de conta")}
        name="accountId"
        required
        maxLength={128}
      />
      <p>
        {t(
          "El destinatario facilita su identificador desde los datos de su cuenta. No se consulta un directorio global de usuarios.",
          "O destinatario facilita o seu identificador desde os datos da súa conta. Non se consulta un directorio global de usuarios.",
        )}
      </p>
    </>
  );
}
export function InvitationDeadline({ role = false }: { role?: boolean }) {
  const { t } = usePreferences();
  return (
    <>
      <p>
        {t("Zona horaria", "Zona horaria")}:{" "}
        {Intl.DateTimeFormat().resolvedOptions().timeZone}
      </p>
      <Deadline
        name="expiresAt"
        label={t("Aceptar antes de", "Aceptar antes de")}
        required
      />
      {role && (
        <Deadline
          name="roleExpiresAt"
          label={t(
            "Permiso válido hasta (opcional)",
            "Permiso válido ata (opcional)",
          )}
        />
      )}
      <p>
        {t(
          "La invitación no concede permisos. El destinatario debe aceptarla desde su perfil con MFA.",
          "A invitación non concede permisos. O destinatario debe aceptala desde o seu perfil con MFA.",
        )}
      </p>
    </>
  );
}
export function MunicipalityField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = usePreferences();
  return (
    <Input
      label={t("Identificador del municipio", "Identificador do municipio")}
      name="tenantId"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required
      pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    />
  );
}
export function Receipt({
  result,
  message,
}: {
  result: { tenantId?: string; invitationId?: string; accountId?: string };
  message: string;
}) {
  const { t } = usePreferences();
  return (
    <section role="status">
      <h2>{message}</h2>
      {result.tenantId && (
        <p>
          {t("Municipio", "Municipio")}: {result.tenantId}
        </p>
      )}
      {result.invitationId && (
        <p>
          {t("Invitación", "Invitación")}: {result.invitationId}
        </p>
      )}
      {result.accountId && (
        <p>
          {t("Cuenta", "Conta")}: {result.accountId}
        </p>
      )}
    </section>
  );
}
