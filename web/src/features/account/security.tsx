import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActionForm, textField } from "../../app/action";
import { api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { PageTitle, SecretField, useAuthSession } from "./shared";

export function FactorField({ optional = false }: { optional?: boolean }) {
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
interface SessionRecord {
  token: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string | null;
}
export function AccountSecurity() {
  const { account, refresh } = useSession();
  const { t, locale } = usePreferences();
  const session = useAuthSession();
  const sessions = useQuery({
    queryKey: ["private", account?.accountId, "sessions"],
    queryFn: ({ signal }) =>
      api<SessionRecord[]>("/api/auth/list-sessions", { signal }, locale),
    gcTime: 0,
  });
  const [enrollment, setEnrollment] = useState<{
    totpURI: string;
    backupCodes: string[];
  }>();
  const [codes, setCodes] = useState<string[]>();
  if (session.isPending) return <Loading />;
  if (session.isError)
    return (
      <Failure error={session.error} retry={() => void session.refetch()} />
    );
  async function updated() {
    await refresh();
    await session.refetch();
    await sessions.refetch();
  }
  return (
    <>
      <PageTitle
        title={t("Seguridad de tu cuenta", "Seguridade da túa conta")}
      />
      <section className={styles.section}>
        <h2>{t("Contraseña", "Contrasinal")}</h2>
        <p>
          {t(
            "El cambio cerrará las demás sesiones de tu cuenta.",
            "O cambio pechará as demais sesións da túa conta.",
          )}
        </p>
        <ActionForm
          label={t("Cambiar contraseña", "Cambiar contrasinal")}
          success={t("Contraseña actualizada.", "Contrasinal actualizado.")}
          submit={async (data) => {
            await api(
              "/api/auth/change-password",
              {
                method: "POST",
                body: JSON.stringify({
                  currentPassword: textField(data, "currentPassword"),
                  newPassword: textField(data, "newPassword"),
                  revokeOtherSessions: true,
                }),
              },
              locale,
            );
            await updated();
          }}
        >
          <SecretField
            label={t("Contraseña actual", "Contrasinal actual")}
            name="currentPassword"
          />
          <SecretField
            label={t("Nueva contraseña", "Novo contrasinal")}
            name="newPassword"
            autoComplete="new-password"
            minLength={8}
          />
        </ActionForm>
      </section>
      <section className={styles.section}>
        <h2>{t("Verificación en dos pasos", "Verificación en dous pasos")}</h2>
        <p>
          {session.data.user.twoFactorEnabled
            ? t(
                "MFA está activado. Las operaciones sensibles requieren una verificación de los últimos cinco minutos.",
                "MFA está activado. As operacións sensibles requiren unha verificación dos últimos cinco minutos.",
              )
            : t(
                "Añade una aplicación de autenticación para proteger tu acceso.",
                "Engade unha aplicación de autenticación para protexer o teu acceso.",
              )}
        </p>
        {!session.data.user.twoFactorEnabled && !enrollment && (
          <ActionForm
            label={t("Configurar MFA", "Configurar MFA")}
            submit={async (data) => {
              const result = await api<{
                totpURI: string;
                backupCodes: string[];
              }>(
                "/api/auth/two-factor/enable",
                {
                  method: "POST",
                  body: JSON.stringify({
                    password: textField(data, "password"),
                  }),
                },
                locale,
              );
              setEnrollment(result);
              setCodes(result.backupCodes);
            }}
          >
            <SecretField
              label={t("Contraseña actual", "Contrasinal actual")}
              name="password"
            />
          </ActionForm>
        )}
        {enrollment && (
          <>
            <p>
              {t(
                "En tu aplicación de autenticación, añade Quenda con esta clave. Utiliza códigos de seis cifras que cambian cada 30 segundos.",
                "Na túa aplicación de autenticación, engade Quenda con esta clave. Utiliza códigos de seis cifras que cambian cada 30 segundos.",
              )}
            </p>
            <Input
              label={t("Clave de configuración", "Clave de configuración")}
              value={
                new URL(enrollment.totpURI).searchParams.get("secret") ?? ""
              }
              readOnly
              autoComplete="off"
            />
          </>
        )}
        {(session.data.user.twoFactorEnabled || enrollment) && (
          <ActionForm
            label={
              enrollment
                ? t("Activar MFA", "Activar MFA")
                : t("Verificar MFA", "Verificar MFA")
            }
            success={t("Verificación completada.", "Verificación completada.")}
            submit={async (data) => {
              await verifyFactor(data, locale);
              setEnrollment(undefined);
              await updated();
            }}
          >
            {enrollment ? (
              <Input
                label={t("Código de autenticación", "Código de autenticación")}
                name="totpCode"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            ) : (
              <FactorField />
            )}
          </ActionForm>
        )}
        {codes && (
          <div>
            <h3>{t("Códigos de respaldo", "Códigos de respaldo")}</h3>
            <p>
              {t(
                "Guárdalos en un lugar seguro. Cada código sirve una sola vez; no se guardan en el navegador.",
                "Gárdaos nun lugar seguro. Cada código serve unha soa vez; non se gardan no navegador.",
              )}
            </p>
            <pre className={styles.secret}>{codes.join("\n")}</pre>
            <Button variant="secondary" onClick={() => setCodes(undefined)}>
              {t("He guardado los códigos", "Gardei os códigos")}
            </Button>
          </div>
        )}
        {session.data.user.twoFactorEnabled && (
          <>
            <h3>
              {t("Renovar códigos de respaldo", "Renovar códigos de respaldo")}
            </h3>
            <p>
              {t(
                "Los códigos anteriores dejarán de funcionar.",
                "Os códigos anteriores deixarán de funcionar.",
              )}
            </p>
            <ActionForm
              label={t("Generar nuevos códigos", "Xerar novos códigos")}
              submit={async (data) => {
                const result = await api<{ backupCodes: string[] }>(
                  "/api/auth/two-factor/generate-backup-codes",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      password: textField(data, "password"),
                    }),
                  },
                  locale,
                );
                setCodes(result.backupCodes);
              }}
            >
              <SecretField
                label={t("Contraseña actual", "Contrasinal actual")}
                name="password"
              />
            </ActionForm>
            <h3>{t("Desactivar MFA", "Desactivar MFA")}</h3>
            <p>
              {t(
                "No se permite mientras mantengas permisos administrativos vigentes.",
                "Non se permite mentres manteñas permisos administrativos vixentes.",
              )}
            </p>
            <ActionForm
              label={t("Desactivar MFA", "Desactivar MFA")}
              danger
              success={t("MFA desactivado.", "MFA desactivado.")}
              submit={async (data) => {
                await api(
                  "/api/auth/two-factor/disable",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      password: textField(data, "password"),
                    }),
                  },
                  locale,
                );
                setEnrollment(undefined);
                setCodes(undefined);
                await updated();
              }}
            >
              <SecretField
                label={t("Contraseña actual", "Contrasinal actual")}
                name="password"
              />
            </ActionForm>
          </>
        )}
      </section>
      <section className={styles.section}>
        <h2>{t("Sesiones abiertas", "Sesións abertas")}</h2>
        {sessions.isPending ? (
          <Loading />
        ) : sessions.isError ? (
          <Failure
            error={sessions.error}
            retry={() => void sessions.refetch()}
          />
        ) : (
          <ul className={styles.list}>
            {sessions.data.map((item) => (
              <li key={item.token} className={styles.listItem}>
                <p>
                  {item.token === session.data.session.token
                    ? t("Esta sesión", "Esta sesión")
                    : t("Otra sesión", "Outra sesión")}{" "}
                  · {new Date(item.createdAt).toLocaleString(locale)}
                </p>
                <p>{item.userAgent}</p>
                {item.token !== session.data.session.token && (
                  <ActionForm
                    label={t("Cerrar esta sesión", "Pechar esta sesión")}
                    submit={async () => {
                      await api(
                        "/api/auth/revoke-session",
                        {
                          method: "POST",
                          body: JSON.stringify({ token: item.token }),
                        },
                        locale,
                      );
                      await sessions.refetch();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <ActionForm
          label={t("Cerrar las demás sesiones", "Pechar as demais sesións")}
          success={t(
            "Las demás sesiones se han cerrado.",
            "As demais sesións pecháronse.",
          )}
          submit={async () => {
            await api(
              "/api/auth/revoke-other-sessions",
              { method: "POST", body: "{}" },
              locale,
            );
            await sessions.refetch();
          }}
        />
      </section>
    </>
  );
}
