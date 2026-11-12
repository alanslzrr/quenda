import { useState } from "react";
import { Navigate } from "react-router";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import SegmentedControl from "../../ui/segmented-control/segmented-control";
import { Select } from "../../ui/select/select";
export function Profile() {
  useMunicipalTheme(undefined);
  const { account, loading, error, refresh } = useSession();
  const { locale, theme, save, pending, t } = usePreferences();
  const [failure, setFailure] = useState<unknown>();
  if (loading) return <Loading />;
  if (error)
    return (
      <Failure error={error} retry={() => void refresh().catch(() => {})} />
    );
  if (!account) return <Navigate to="/acceso" replace />;
  const update = (patch: Parameters<typeof save>[0]) => {
    setFailure(undefined);
    void save(patch).catch(setFailure);
  };
  return (
    <>
      <div className={styles.hero}>
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
        <fieldset disabled={pending} className={styles.choiceGroup}>
          <legend>{t("Apariencia", "Aparencia")}</legend>
          {/* Both themes are named and the active one is marked, so the control reads as a state, not an action.
              The fieldset names the group and disables it while saving. */}
          <SegmentedControl
            value={theme ?? "light"}
            options={[
              { value: "light", label: t("Claro", "Claro") },
              { value: "dark", label: t("Oscuro", "Escuro") },
            ]}
            onValueChange={(value) => {
              if (value !== theme) update({ theme: value as "light" | "dark" });
            }}
          />
        </fieldset>
        {failure !== undefined && <Failure error={failure} />}
      </div>
    </>
  );
}
