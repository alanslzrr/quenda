import { Link } from "react-router";
import { ActionForm, textField } from "../../app/action";
import { api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { blocksEditor, EditorRecovery } from "../../app/read-recovery";
import { Input } from "../../ui/input/input";
import { PageTitle, SecretField, useAuthSession } from "./shared";

export function PersonalDetails() {
  const { t, locale } = usePreferences();
  const session = useAuthSession();
  if (session.isPending) return <Loading />;
  const auth = session.data;
  if (blocksEditor(session) || !auth)
    return (
      <Failure error={session.error} retry={() => void session.refetch()} />
    );
  return (
    <EditorRecovery
      error={session.isError ? session.error : null}
      retry={() => void session.refetch()}
    >
      <PageTitle title={t("Datos personales", "Datos persoais")} />
      <p>
        {t("Identificador de cuenta", "Identificador de conta")}:{" "}
        <code>{auth.user.id}</code>
      </p>
      <section className={styles.section}>
        <h2>{t("Nombre", "Nome")}</h2>
        <ActionForm
          label={t("Guardar nombre", "Gardar nome")}
          success={t("Nombre actualizado.", "Nome actualizado.")}
          submit={async (data) => {
            await api(
              "/api/auth/update-user",
              {
                method: "POST",
                body: JSON.stringify({ name: textField(data, "name").trim() }),
              },
              locale,
            );
            await session.refetch();
          }}
        >
          <Input
            key={auth.user.name}
            label={t("Nombre", "Nome")}
            name="name"
            defaultValue={auth.user.name}
            required
            maxLength={200}
            autoComplete="name"
          />
        </ActionForm>
      </section>
      <section className={styles.section}>
        <h2>{t("Correo electrónico", "Correo electrónico")}</h2>
        <p>{auth.user.email}</p>
        <p>
          {t(
            "Autoriza el cambio desde tu correo actual y verifica el nuevo. Al completarlo se cerrarán todas tus sesiones.",
            "Autoriza o cambio desde o teu correo actual e verifica o novo. Ao completalo pecharanse todas as túas sesións.",
          )}
        </p>
        <p>
          {t(
            "Si no puedes acceder al correo actual, solicita recuperación asistida al equipo que opera Quenda.",
            "Se non podes acceder ao correo actual, solicita recuperación asistida ao equipo que opera Quenda.",
          )}
        </p>
        <ActionForm
          label={t("Solicitar cambio de correo", "Solicitar cambio de correo")}
          success={t(
            "Revisa tu correo actual para autorizar la solicitud.",
            "Revisa o teu correo actual para autorizar a solicitude.",
          )}
          submit={async (data) => {
            await api(
              "/api/me/email-change/request",
              {
                method: "POST",
                body: JSON.stringify({
                  newEmail: textField(data, "email"),
                  password: textField(data, "password"),
                }),
              },
              locale,
            );
          }}
        >
          <Input
            label={t("Nuevo correo", "Novo correo")}
            type="email"
            name="email"
            required
            maxLength={320}
            autoComplete="email"
          />
          <SecretField
            label={t("Contraseña actual", "Contrasinal actual")}
            name="password"
          />
        </ActionForm>
        {auth.user.twoFactorEnabled && (
          <p>
            <Link to="/perfil/seguridad">
              {t(
                "Verificar MFA antes de continuar",
                "Verificar MFA antes de continuar",
              )}
            </Link>
          </p>
        )}
      </section>
    </EditorRecovery>
  );
}
