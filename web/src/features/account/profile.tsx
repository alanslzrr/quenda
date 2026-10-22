import { useState } from "react";
import { Link, Navigate } from "react-router";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Select } from "../../ui/select/select";
import { ThemeSwitch } from "../../ui/theme-switch/theme-switch";
export function Profile() {
  useMunicipalTheme(undefined);
  const { account, loading, error } = useSession();
  const { locale, theme, save, pending, t } = usePreferences();
  const [failure, setFailure] = useState<unknown>();
  if (loading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!account) return <Navigate to="/acceso" replace />;
  const update = (patch: Parameters<typeof save>[0]) => {
    setFailure(undefined);
    void save(patch).catch(setFailure);
  };
  return (
    <>
      <div className={styles.hero}>
        <p className={styles.eyebrow}>{account.email}</p>
        <h1 className={styles.title}>
          {t("Preferencias de tu cuenta", "Preferencias da túa conta")}
        </h1>
        <p className={styles.description}>
          {t(
            "Estos ajustes se aplican al utilizar cualquier municipio de esta instancia.",
            "Estes axustes aplícanse ao utilizar calquera municipio desta instancia.",
          )}
        </p>
      </div>
      <Link to="/administracion">
        {t("Administración municipal", "Administración municipal")}
      </Link>
      <div className={styles.form}>
        <Select
          label={t("Idioma", "Idioma")}
          value={locale}
          disabled={pending}
          options={[
            { value: "gl", label: "Galego" },
            { value: "es", label: "Castellano" },
          ]}
          onValueChange={(value) => update({ locale: value as "es" | "gl" })}
        />
        <fieldset disabled={pending} style={{ border: 0, padding: 0 }}>
          <legend>{t("Apariencia", "Aparencia")}</legend>
          <ThemeSwitch
            theme={theme ?? "light"}
            label={
              theme === "dark"
                ? t("Modo oscuro", "Modo escuro")
                : t("Modo claro", "Modo claro")
            }
            onThemeChange={(value) => update({ theme: value })}
          />
        </fieldset>
        {failure !== undefined && <Failure error={failure} />}
      </div>
    </>
  );
}
