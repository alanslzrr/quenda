import { useRef, useState } from "react";
import type { Appearance } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import layout from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { blocksEditor, EditorRecovery } from "../../app/read-recovery";
import { defaultAppearance } from "../../app/theme";
import { useAppearancePreview } from "../../app/theme-provider";
import { Button } from "../../ui/button/button";
import { Select } from "../../ui/select/select";
import { ManagementPage } from "./page";
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
    <ManagementPage
      title={t("Apariencia", "Aparencia")}
      description={t(
        "La apariencia guardada se aplica a la interfaz pública del municipio. Puedes probarla temporalmente en toda esta aplicación sin cambiar tu tema personal.",
        "A aparencia gardada aplícase á interface pública do municipio. Podes probala temporalmente en toda esta aplicación sen cambiar o teu tema persoal.",
      )}
    >
      {q.isPending ? (
        <Loading />
      ) : blocksEditor(q) || !q.data ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        q.data && (
          <EditorRecovery
            error={q.isError ? q.error : null}
            retry={() => void q.refetch()}
          >
            <AppearanceForm key={reset} initial={q.data} />
            <Button
              type="button"
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
          </EditorRecovery>
        )
      )}
    </ManagementPage>
  );
}
function AppearanceForm({ initial }: { initial: Appearance }) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [draft, setDraft] = useState(initial);
  const [preview, setPreview] = useState<"light" | "dark" | null>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  useAppearancePreview(draft, preview);
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
      <div className={layout.form}>
        <Select
          ref={previewTrigger}
          label={t("Modo de vista previa", "Modo de vista previa")}
          value={preview ?? "personal"}
          options={[
            {
              value: "personal",
              label: t(
                "Sin vista previa · tema personal",
                "Sen vista previa · tema persoal",
              ),
            },
            ...modes,
          ]}
          onValueChange={(value) =>
            setPreview(
              value === "personal" ? null : (value as "light" | "dark"),
            )
          }
        />
        {preview ? (
          <div role="status">
            <p>
              {t(
                "Vista previa temporal en toda la aplicación. No cambia tu preferencia personal ni publica el borrador.",
                "Vista previa temporal en toda a aplicación. Non cambia a túa preferencia persoal nin publica o borrador.",
              )}
            </p>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setPreview(null);
                previewTrigger.current?.focus();
              }}
            >
              {t("Salir de la vista previa", "Saír da vista previa")}
            </Button>
          </div>
        ) : (
          <p>
            {t(
              "Selecciona Claro u Oscuro para probar la apariencia en toda la aplicación.",
              "Selecciona Claro ou Escuro para probar a aparencia en toda a aplicación.",
            )}
          </p>
        )}
      </div>
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
          type="button"
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
      </MunicipalForm>
    </>
  );
}
