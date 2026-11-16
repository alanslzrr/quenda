import { type FormEvent, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "../../app/api";
import { Failure } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Alert } from "../../ui/alert/alert";
import { Button } from "../../ui/button/button";
import { Input } from "../../ui/input/input";
import { PasswordField } from "../../ui/password-field/password-field";
import { FactorField, verifyFactor } from "./factor";
import { safeReturnPath } from "./shared";
export function SignIn({ register = false }: { register?: boolean }) {
  useMunicipalTheme(undefined);
  const { locale, t } = usePreferences();
  const { account, refresh } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = safeReturnPath(params.get("returnTo"));
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [failure, setFailure] = useState<unknown>();
  const [challenge, setChallenge] = useState(false);
  const [registered, setRegistered] = useState(false);
  if (account) return <Navigate to={returnTo} replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(undefined);
    const data = new FormData(event.currentTarget);
    try {
      if (challenge) {
        await verifyFactor(data, locale);
        await refresh();
        navigate(returnTo, { replace: true });
      } else if (register) {
        await api(
          "/api/auth/sign-up/email",
          {
            method: "POST",
            body: JSON.stringify({
              email: data.get("email"),
              name: data.get("name"),
              password: data.get("password"),
              callbackURL: `${location.origin}/acceso${returnTo === "/perfil" ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}`,
            }),
          },
          locale,
        );
        setRegistered(true);
      } else {
        const result = await api<{ twoFactorRedirect?: boolean }>(
          "/api/auth/sign-in/email",
          {
            method: "POST",
            body: JSON.stringify({
              email: data.get("email"),
              password: data.get("password"),
              rememberMe: false,
            }),
          },
          locale,
        );
        if (result.twoFactorRedirect) setChallenge(true);
        else {
          await refresh();
          navigate(returnTo, { replace: true });
        }
      }
    } catch (error) {
      setFailure(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className={styles.hero}>
        <p className={styles.eyebrow}>Quenda</p>
        <h1 className={styles.title}>
          {challenge
            ? t("Verifica tu acceso", "Verifica o teu acceso")
            : register
              ? t("Crea tu cuenta", "Crea a túa conta")
              : t("Accede a tu cuenta", "Accede á túa conta")}
        </h1>
        <p className={styles.description}>
          {t(
            "Una cuenta para los servicios municipales de esta instancia.",
            "Unha conta para os servizos municipais desta instancia.",
          )}
        </p>
      </div>
      {params.get("notice") === "deactivated" && (
        <Alert
          tone="success"
          title={t("Cuenta desactivada.", "Conta desactivada.")}
        />
      )}
      {params.get("notice") === "email-changed" && (
        <Alert
          tone="success"
          title={t(
            "Correo actualizado. Inicia sesión con el nuevo correo.",
            "Correo actualizado. Inicia sesión co novo correo.",
          )}
        />
      )}
      {params.has("error") && (
        <Alert
          tone="danger"
          title={t(
            "No se ha podido verificar el enlace. Solicita uno nuevo.",
            "Non se puido verificar a ligazón. Solicita unha nova.",
          )}
        />
      )}
      {registered ? (
        <Alert
          tone="success"
          title={t(
            "Comprueba tu correo para verificar la cuenta.",
            "Comproba o teu correo para verificar a conta.",
          )}
        />
      ) : (
        <form className={styles.form} onSubmit={submit}>
          {challenge ? (
            <FactorField focus />
          ) : (
            <>
              {register && (
                <Input
                  label={t("Nombre", "Nome")}
                  name="name"
                  autoComplete="name"
                  maxLength={200}
                  required
                />
              )}
              <Input
                label={t("Correo electrónico", "Correo electrónico")}
                name="email"
                type="email"
                autoComplete="email"
                required
              />
              <PasswordField
                messages={{
                  showPassword: t("Mostrar contraseña", "Mostrar contrasinal"),
                  hidePassword: t("Ocultar contraseña", "Ocultar contrasinal"),
                }}
                label={t("Contraseña", "Contrasinal")}
                name="password"
                autoComplete={register ? "new-password" : "current-password"}
                required
              />
            </>
          )}
          {register && !challenge && (
            <p>
              <Link to="/privacidad">
                {t(
                  "Cómo se tratan tus datos al crear la cuenta",
                  "Como se tratan os teus datos ao crear a conta",
                )}
              </Link>
            </p>
          )}
          {failure !== undefined && <Failure error={failure} />}
          <Button type="submit" loading={busy} disabled={busy}>
            {challenge
              ? t("Verificar", "Verificar")
              : register
                ? t("Crear cuenta", "Crear conta")
                : t("Entrar", "Entrar")}
          </Button>
          {challenge && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                // The second-factor window may have expired; start again from the password step.
                setChallenge(false);
                setFailure(undefined);
              }}
            >
              {t("Volver al acceso", "Volver ao acceso")}
            </Button>
          )}
          {!challenge && !register && (
            <nav
              className={styles.fields}
              aria-label={t("Recuperación de acceso", "Recuperación de acceso")}
            >
              <Link to="/recuperar">
                {t("He olvidado mi contraseña", "Esquecín o meu contrasinal")}
              </Link>
              <Link to="/verificar-correo">
                {t("Reenviar verificación", "Reenviar verificación")}
              </Link>
              <Link to="/reactivar">
                {t("Reactivar mi cuenta", "Reactivar a miña conta")}
              </Link>
            </nav>
          )}
          {!challenge && (
            <Link
              to={`${register ? "/acceso" : "/registro"}?returnTo=${encodeURIComponent(returnTo)}`}
            >
              {register
                ? t("Ya tengo una cuenta", "Xa teño unha conta")
                : t("Crear una cuenta", "Crear unha conta")}
            </Link>
          )}
        </form>
      )}
    </>
  );
}
