import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ActionForm, textField } from "../../app/action";
import { announce } from "../../app/announce";
import { api } from "../../app/api";
import styles from "../../app/layout.module.css";
import { releaseLinkToken, takeLinkToken } from "../../app/link-token.ts";
import { usePreferences } from "../../app/preferences-provider";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Alert } from "../../ui/alert/alert";
import { Input } from "../../ui/input/input";
import { FactorField, factorProof } from "./factor";
import { PageTitle, SecretField } from "./shared";

// Keep action tokens in component memory; never persist them or mutate by GET.
function useLinkToken(query = false) {
  const [token] = useState(() =>
    takeLinkToken(
      location.pathname,
      query
        ? (new URLSearchParams(location.search).get("token") ?? "")
        : location.hash.slice(1),
    ),
  );
  useEffect(() => {
    const path = location.pathname;
    const url = new URL(location.href);
    url.hash = "";
    url.searchParams.delete("token");
    history.replaceState(history.state, "", url);
    // A remount on the same page keeps the token; leaving the page discards it.
    return () => {
      if (location.pathname !== path) releaseLinkToken(path);
    };
  }, []);
  return token;
}
export function RecoveryRequest({
  kind,
}: {
  kind: "reset" | "reactivate" | "verify";
}) {
  useMunicipalTheme(undefined);
  const { t, locale } = usePreferences();
  const title =
    kind === "reset"
      ? t("Recuperar contraseña", "Recuperar contrasinal")
      : kind === "reactivate"
        ? t("Reactivar tu cuenta", "Reactivar a túa conta")
        : t("Reenviar verificación", "Reenviar verificación");
  return (
    <>
      <PageTitle title={title}>
        {kind === "reactivate"
          ? t(
              "Recupera el acceso personal de una baja voluntaria. No levanta suspensiones ni recupera permisos administrativos.",
              "Recupera o acceso persoal dunha baixa voluntaria. Non levanta suspensións nin recupera permisos administrativos.",
            )
          : t(
              "Te enviaremos las instrucciones si la cuenta admite esta operación.",
              "Enviarémosche as instrucións se a conta admite esta operación.",
            )}
      </PageTitle>
      <ActionForm
        label={t("Enviar instrucciones", "Enviar instrucións")}
        success={t(
          "Si la solicitud es válida, recibirás un correo con las instrucciones.",
          "Se a solicitude é válida, recibirás un correo coas instrucións.",
        )}
        submit={async (data) => {
          const email = textField(data, "email");
          const path =
            kind === "reset"
              ? "/api/auth/request-password-reset"
              : kind === "verify"
                ? "/api/auth/send-verification-email"
                : "/api/account/reactivation/request";
          const body =
            kind === "reset"
              ? {
                  email,
                  redirectTo: `${location.origin}/account/reset-password`,
                }
              : kind === "verify"
                ? { email, callbackURL: `${location.origin}/acceso` }
                : { email, password: textField(data, "password") };
          await api(
            path,
            { method: "POST", body: JSON.stringify(body) },
            locale,
          );
        }}
      >
        <Input
          label={t("Correo electrónico", "Correo electrónico")}
          name="email"
          type="email"
          required
          // The address identifies an existing account, so password managers fill it as the username.
          autoComplete="username"
          spellCheck={false}
        />
        {kind === "reactivate" && (
          <SecretField
            name="password"
            label={t("Contraseña actual", "Contrasinal actual")}
          />
        )}
      </ActionForm>
      <p>
        <Link to="/acceso">{t("Volver al acceso", "Volver ao acceso")}</Link>
      </p>
    </>
  );
}
/**
 * A success replaces the form, so the page announcer speaks it once shown: a live region mounted together with its
 * text is not announced reliably, and a status role here would read it a second time.
 */
function Success({ title }: { title: string }) {
  useEffect(() => {
    announce(title);
  }, [title]);
  return <Alert tone="success" title={title} role="none" />;
}
export function ResetPassword() {
  useMunicipalTheme(undefined);
  const { t, locale } = usePreferences();
  const token = useLinkToken(true);
  const [params] = useSearchParams();
  const [done, setDone] = useState(false);
  return (
    <>
      <PageTitle
        title={t("Establecer nueva contraseña", "Establecer novo contrasinal")}
      />
      {!token || params.has("error") ? (
        <Alert
          tone="danger"
          title={t(
            "El enlace no es válido. Solicita uno nuevo.",
            "A ligazón non é válida. Solicita unha nova.",
          )}
        />
      ) : done ? (
        <Success
          title={t(
            "Contraseña actualizada. Inicia sesión de nuevo.",
            "Contrasinal actualizado. Inicia sesión de novo.",
          )}
        />
      ) : (
        <ActionForm
          label={t("Guardar contraseña", "Gardar contrasinal")}
          submit={async (data) => {
            await api(
              "/api/auth/reset-password",
              {
                method: "POST",
                body: JSON.stringify({
                  token,
                  newPassword: textField(data, "password"),
                }),
              },
              locale,
            );
            setDone(true);
          }}
        >
          <SecretField
            label={t("Nueva contraseña", "Novo contrasinal")}
            name="password"
            autoComplete="new-password"
            minLength={8}
            description={t("Mínimo 8 caracteres", "Mínimo 8 caracteres")}
          />
        </ActionForm>
      )}
      <p>
        <Link to="/acceso">{t("Acceder", "Acceder")}</Link> ·{" "}
        <Link to="/recuperar">
          {t("Solicitar otro enlace", "Solicitar outra ligazón")}
        </Link>
      </p>
    </>
  );
}
export function ReactivateAccount() {
  useMunicipalTheme(undefined);
  const { t, locale } = usePreferences();
  const token = useLinkToken();
  const [done, setDone] = useState(false);
  return (
    <>
      <PageTitle title={t("Confirmar reactivación", "Confirmar reactivación")}>
        {t(
          "Confirma tu contraseña y, si tenías activada la verificación en dos pasos, tu código. Después podrás iniciar una sesión nueva.",
          "Confirma o teu contrasinal e, se tiñas activada a verificación en dous pasos, o teu código. Despois poderás iniciar unha sesión nova.",
        )}
      </PageTitle>
      {!token ? (
        <Alert
          tone="danger"
          title={t(
            "Abre el enlace recibido por correo.",
            "Abre a ligazón recibida por correo.",
          )}
        />
      ) : done ? (
        <Success
          title={t(
            "Cuenta reactivada. No se han recuperado permisos administrativos.",
            "Conta reactivada. Non se recuperaron permisos administrativos.",
          )}
        />
      ) : (
        <ActionForm
          label={t("Reactivar cuenta", "Reactivar conta")}
          submit={async (data) => {
            await api(
              "/api/account/reactivation/confirm",
              {
                method: "POST",
                body: JSON.stringify({
                  token,
                  password: textField(data, "password"),
                  ...factorProof(data),
                }),
              },
              locale,
            );
            setDone(true);
          }}
        >
          <SecretField
            name="password"
            label={t("Contraseña actual", "Contrasinal actual")}
          />
          <FactorField optional />
        </ActionForm>
      )}
      <p>
        <Link to="/acceso">{t("Acceder", "Acceder")}</Link> ·{" "}
        <Link to="/reactivar">
          {t("Solicitar otro enlace", "Solicitar outra ligazón")}
        </Link>
      </p>
    </>
  );
}
export function EmailChangeConfirmation({
  step,
}: {
  step: "approve" | "confirm";
}) {
  useMunicipalTheme(undefined);
  const { t, locale } = usePreferences();
  const token = useLinkToken();
  const [done, setDone] = useState(false);
  return (
    <>
      <PageTitle
        title={
          step === "approve"
            ? t("Autorizar cambio de correo", "Autorizar cambio de correo")
            : t("Verificar nuevo correo", "Verificar novo correo")
        }
      >
        {t(
          "Utiliza la misma sesión con la que solicitaste el cambio. Abrir el enlace no ejecuta la operación.",
          "Utiliza a mesma sesión coa que solicitaches o cambio. Abrir a ligazón non executa a operación.",
        )}
      </PageTitle>
      {!token ? (
        <Alert
          tone="danger"
          title={t(
            "Abre el enlace recibido por correo.",
            "Abre a ligazón recibida por correo.",
          )}
        />
      ) : done ? (
        <Success
          title={t(
            "Revisa el nuevo correo para completar la verificación.",
            "Revisa o novo correo para completar a verificación.",
          )}
        />
      ) : (
        <ActionForm
          label={
            step === "approve"
              ? t("Autorizar cambio", "Autorizar cambio")
              : t("Confirmar nuevo correo", "Confirmar novo correo")
          }
          submit={async (data) => {
            const password = textField(data, "password");
            await api(
              `/api/me/email-change/${step}`,
              {
                method: "POST",
                body: JSON.stringify({
                  token,
                  ...(password ? { password } : {}),
                }),
              },
              locale,
            );
            if (step === "confirm")
              window.location.replace("/acceso?notice=email-changed");
            else setDone(true);
          }}
        >
          {step === "confirm" && (
            <>
              <p className={styles.description}>
                {t(
                  "En una recuperación asistida, confirma también tu contraseña y completa la verificación en dos pasos desde Seguridad si la tienes activada.",
                  "Nunha recuperación asistida, confirma tamén o teu contrasinal e completa a verificación en dous pasos desde Seguridade se a tes activada.",
                )}
              </p>
              <SecretField
                name="password"
                required={false}
                label={t(
                  "Contraseña para recuperación asistida",
                  "Contrasinal para recuperación asistida",
                )}
              />
            </>
          )}
        </ActionForm>
      )}
    </>
  );
}
