import { useEffect, useId, useState } from "react";
import { Navigate } from "react-router";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import type { Theme } from "../../app/preferences";
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
  const appearanceId = useId();
  // Arrow keys move the radio selection at once, so the chosen theme is held here and saved once the keys come to rest
  // instead of on every step. A choice made while another save runs waits for it, then saves.
  const [choice, setChoice] = useState<Theme>();
  const saved = theme ?? "light";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `save` is a new function on every render; the timer restarts only when the choice or the saved state changes.
  useEffect(() => {
    if (!choice || pending) return;
    if (choice === saved) {
      setChoice(undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      setFailure(undefined);
      save({ theme: choice }).then(
        () =>
          setChoice((current) => (current === choice ? undefined : current)),
        (error: unknown) => {
          setFailure(error);
          setChoice(undefined);
        },
      );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [choice, pending, saved]);
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
        <div className={styles.choiceGroup}>
          <span id={appearanceId} className={styles.choiceLabel}>
            {t("Apariencia", "Aparencia")}
          </span>
          {/* Both themes are named and the active one is checked, so the control reads as a state, not an action.
              It stays enabled while saving: disabling it would drop keyboard focus to the page. */}
          <SegmentedControl
            labelledBy={appearanceId}
            value={choice ?? saved}
            options={[
              { value: "light", label: t("Claro", "Claro") },
              { value: "dark", label: t("Oscuro", "Escuro") },
            ]}
            onValueChange={(value) => setChoice(value as Theme)}
          />
        </div>
        {failure !== undefined && <Failure error={failure} />}
      </div>
    </>
  );
}
