import { useState } from "react";
import type { Appearance } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { defaultAppearance, themeVariables } from "../../app/theme";
import { Button } from "../../ui/button/button";
import { Select } from "../../ui/select/select";
import styles from "./municipal.module.css";
import {
  Denied,
  endpoint,
  MunicipalForm,
  useMunicipality,
  useMunicipalQuery,
} from "./shared";
export function MunicipalAppearance() {
  const m = useMunicipality();
  if (!m.administrator) return <Denied />;
  return <AppearanceEditor />;
}
function AppearanceEditor() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const q = useMunicipalQuery<Appearance>(
    `/api/public/municipalities/${m.id}/appearance`,
  );
  const [reset, setReset] = useState(0);
  return (
    <>
      <h1>{t("Apariencia", "Aparencia")}</h1>
      <p>
        {t(
          "Solo se aplica a la interfaz pública del municipio. La administración mantiene el tema de Quenda.",
          "Só se aplica á interface pública do municipio. A administración mantén o tema de Quenda.",
        )}
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <Failure error={q.error} />
      ) : (
        q.data && (
          <>
            <AppearanceForm key={reset} initial={q.data} />
            <Button
              variant="ghost"
              onClick={async () => {
                const r = await q.refetch();
                if (r.isSuccess) setReset((v) => v + 1);
              }}
            >
              {t(
                "Descartar borrador y recargar",
                "Descartar borrador e recargar",
              )}
            </Button>
          </>
        )
      )}
    </>
  );
}
function AppearanceForm({ initial }: { initial: Appearance }) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [draft, setDraft] = useState(initial);
  const [preview, setPreview] = useState<"light" | "dark">(
    initial.defaultTheme,
  );
  const palettes = [
    { value: "neutral", label: t("Neutro", "Neutro") },
    { value: "blue", label: t("Azul", "Azul") },
    { value: "green", label: t("Verde", "Verde") },
  ];
  const modes = [
    { value: "light", label: t("Claro", "Claro") },
    { value: "dark", label: t("Oscuro", "Escuro") },
  ];
  return (
    <>
      <MunicipalForm
        path={`${endpoint(m.id)}/appearance`}
        method="PUT"
        label={t("Guardar apariencia", "Gardar aparencia")}
        body={() => ({
          expectedVersion: draft.version,
          lightPalette: draft.lightPalette,
          darkPalette: draft.darkPalette,
          defaultTheme: draft.defaultTheme,
        })}
        onSaved={(r) => setDraft(r as Appearance)}
      >
        <Select
          placeholder={t("Selecciona una opción", "Selecciona unha opción")}
          label={t("Paleta clara", "Paleta clara")}
          options={palettes}
          value={draft.lightPalette}
          onValueChange={(v) =>
            setDraft({
              ...draft,
              lightPalette: v as Appearance["lightPalette"],
            })
          }
        />
        <Select
          placeholder={t("Selecciona una opción", "Selecciona unha opción")}
          label={t("Paleta oscura", "Paleta escura")}
          options={palettes}
          value={draft.darkPalette}
          onValueChange={(v) =>
            setDraft({ ...draft, darkPalette: v as Appearance["darkPalette"] })
          }
        />
        <Select
          placeholder={t("Selecciona una opción", "Selecciona unha opción")}
          label={t("Modo inicial", "Modo inicial")}
          options={modes}
          value={draft.defaultTheme}
          onValueChange={(v) =>
            setDraft({
              ...draft,
              defaultTheme: v as Appearance["defaultTheme"],
            })
          }
        />
        <p>
          {t(
            "Cada paleta combina fondo, texto y acento con contraste accesible. La preferencia personal del usuario tiene prioridad sobre el modo inicial.",
            "Cada paleta combina fondo, texto e acento con contraste accesible. A preferencia persoal do usuario ten prioridade sobre o modo inicial.",
          )}
        </p>
        <Button
          variant="secondary"
          onClick={() =>
            setDraft({ ...defaultAppearance, version: draft.version })
          }
        >
          {t(
            "Restaurar valores predeterminados",
            "Restaurar valores predeterminados",
          )}
        </Button>
        <p>
          {t(
            "La vista previa y la restauración no se publican hasta guardar.",
            "A vista previa e a restauración non se publican ata gardar.",
          )}
        </p>
        <Select
          placeholder={t("Selecciona una opción", "Selecciona unha opción")}
          label={t("Modo de vista previa", "Modo de vista previa")}
          value={preview}
          options={modes}
          onValueChange={(v) => setPreview(v as "light" | "dark")}
        />
      </MunicipalForm>
      <section
        aria-label={t("Vista previa pública", "Vista previa pública")}
        className={styles.preview}
        style={themeVariables(preview, draft)}
        data-lumen=""
      >
        <h2>{m.name}</h2>
        <p>
          {t(
            "Consulta las instalaciones y elige una franja disponible.",
            "Consulta as instalacións e escolle unha franxa dispoñible.",
          )}
        </p>
        <Button type="button" aria-disabled="true">
          {t("Consultar disponibilidad", "Consultar dispoñibilidade")}
        </Button>
      </section>
    </>
  );
}
