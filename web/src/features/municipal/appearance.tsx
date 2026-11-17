import { RotateCcw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import type { Appearance, ColorOverrides } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { blocksEditor, EditorRecovery } from "../../app/read-recovery";
import { browserStorage } from "../../app/storage";
import { useSystemTheme } from "../../app/system-theme";
import {
  type ColorProblem,
  colorProblem,
  defaultAppearance,
  resolveColors,
} from "../../app/theme";
import { useAppearancePreview } from "../../app/theme-provider";
import {
  type CornerId,
  cornerChoices,
  type FontId,
  fontChoices,
  isThemeId,
  type ModeColors,
  type ThemeId,
  themeCatalog,
  themeIds,
} from "../../app/themes";
import { Button } from "../../ui/button/button";
import { DropdownMenu } from "../../ui/dropdown-menu/dropdown-menu";
import SegmentedControl from "../../ui/segmented-control/segmented-control";
import styles from "./appearance.module.css";
import { MunicipalIdentity } from "./identity";
import { ManagementPage } from "./page";
import {
  Denied,
  endpoint,
  MunicipalForm,
  useMunicipality,
  useMunicipalQuery,
} from "./shared";

type Mode = "light" | "dark";
type Settings = Omit<Appearance, "version">;

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
  return (
    <ManagementPage
      title={t("Apariencia", "Aparencia")}
      description={t(
        "El nombre, el logo y el tema identifican al municipio en su página pública y en su gestión. El nombre y el logo se publican al guardarlos; el tema se prueba al momento en esta pantalla y nadie más lo ve hasta que lo guardes. Cada persona solo elige si lo ve en claro u oscuro.",
        "O nome, o logo e o tema identifican o municipio na súa páxina pública e na súa xestión. O nome e o logo publícanse ao gardalos; o tema próbase ao momento nesta pantalla e ninguén máis o ve ata que o gardes. Cada persoa só escolle se o ve en claro ou escuro.",
      )}
    >
      <div className={styles.page}>
        <MunicipalIdentity />
        {q.isPending ? (
          <Loading />
        ) : blocksEditor(q) || !q.data ? (
          <Failure error={q.error} retry={() => void q.refetch()} />
        ) : (
          <EditorRecovery
            error={q.isError ? q.error : null}
            retry={() => void q.refetch()}
          >
            <AppearanceForm
              saved={q.data}
              reload={async () => (await q.refetch()).data ?? undefined}
            />
          </EditorRecovery>
        )}
      </div>
    </ManagementPage>
  );
}

const settingsOf = ({ version: _, ...settings }: Appearance): Settings =>
  settings;
/** Same settings regardless of key order, so a reordered object is not "unsaved". */
function same(a: Settings, b: Settings) {
  const colors = (value: ColorOverrides) =>
    JSON.stringify(
      Object.entries(value).sort(([x], [y]) => x.localeCompare(y)),
    );
  return (
    a.theme === b.theme &&
    a.font === b.font &&
    a.corners === b.corners &&
    a.defaultTheme === b.defaultTheme &&
    colors(a.light) === colors(b.light) &&
    colors(a.dark) === colors(b.dark)
  );
}

/** The unsaved draft survives a navigation or reload in this tab, tied to the version it started from. */
function useStoredDraft(tenantId: string, saved: Appearance) {
  const key = `quenda.appearance-draft:${tenantId}`;
  const [restored] = useState(() => {
    try {
      const raw = browserStorage("session")?.getItem(key);
      const value = raw ? (JSON.parse(raw) as Appearance) : null;
      return value?.version === saved.version && isThemeId(value.theme)
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const store = useCallback(
    (draft: Appearance | null) => {
      try {
        const storage = browserStorage("session");
        if (draft) storage?.setItem(key, JSON.stringify(draft));
        else storage?.removeItem(key);
      } catch {
        /* Without storage the draft lives only while this view stays open. */
      }
    },
    [key],
  );
  return { restored, store };
}

function AppearanceForm({
  saved: initial,
  reload,
}: {
  saved: Appearance;
  /** Reads the saved appearance again, so a draft that lost a version race can start over from the current one. */
  reload: () => Promise<Appearance | undefined>;
}) {
  const m = useMunicipality();
  const { t, theme: personal } = usePreferences();
  const modeGroup = useId();
  const named = (label: readonly [string, string]) => t(label[0], label[1]);
  const [saved, setSaved] = useState(initial);
  const { restored, store } = useStoredDraft(m.id, initial);
  const [draft, setDraft] = useState<Appearance>(restored ?? initial);
  const systemTheme = useSystemTheme();
  const [mode, setMode] = useState<Mode>(
    (personal === "system" ? systemTheme : personal) ?? initial.defaultTheme,
  );
  const dirty = !same(settingsOf(draft), settingsOf(saved));
  // The whole application shows the draft while this editor is open.
  useAppearancePreview(draft, mode);
  useEffect(() => {
    store(dirty ? draft : null);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft, dirty, store]);

  const problems = useMemo(
    () =>
      (["light", "dark"] as const)
        .map((m) => ({
          mode: m,
          problem: colorProblem(m, {
            ...themeCatalog[draft.theme][m],
            ...draft[m],
          }),
        }))
        .filter(
          (entry): entry is { mode: Mode; problem: ColorProblem } =>
            entry.problem !== null,
        ),
    [draft],
  );
  const [discarding, setDiscarding] = useState(false);
  // Saving removes the bar that held the button, so the confirmation lives in the page.
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (dirty) setJustSaved(false);
  }, [dirty]);
  async function discard() {
    setDiscarding(true);
    try {
      const fresh = (await reload()) ?? saved;
      setSaved(fresh);
      setDraft(fresh);
    } finally {
      setDiscarding(false);
    }
  }
  const discardButton = (
    <Button
      type="button"
      variant="ghost"
      loading={discarding}
      onClick={() => void discard()}
    >
      {t("Descartar", "Descartar")}
    </Button>
  );
  const update = (change: Partial<Settings>) =>
    setDraft((current) => ({ ...current, ...change }));
  const setColor = (key: keyof ModeColors, value: string | null) =>
    setDraft((current) => {
      const next = { ...current[mode] };
      if (value === null) delete next[key];
      else next[key] = value;
      return { ...current, [mode]: next };
    });
  const colors: ModeColors = {
    ...themeCatalog[draft.theme][mode],
    ...draft[mode],
  };
  const modeName = (value: Mode) =>
    value === "light" ? t("claro", "claro") : t("oscuro", "escuro");
  const problemText = (problem: ColorProblem, of: Mode) =>
    ({
      TEXT_CONTRAST: t(
        `En modo ${modeName(of)} el texto no se distingue lo suficiente del fondo (necesita un contraste de 4,5:1).`,
        `No modo ${modeName(of)} o texto non se distingue abondo do fondo (precisa un contraste de 4,5:1).`,
      ),
      ACCENT_CONTRAST: t(
        `En modo ${modeName(of)} el color de acento no se distingue lo suficiente del fondo (necesita 3:1).`,
        `No modo ${modeName(of)} a cor de acento non se distingue abondo do fondo (precisa 3:1).`,
      ),
      LIGHT_BACKGROUND: t(
        "El fondo del modo claro tiene que ser claro.",
        "O fondo do modo claro ten que ser claro.",
      ),
      DARK_BACKGROUND: t(
        "El fondo del modo oscuro tiene que ser oscuro.",
        "O fondo do modo escuro ten que ser escuro.",
      ),
    })[problem];

  return (
    <div className={styles.editor}>
      {restored && dirty && (
        <p className={styles.notice} role="status">
          {t(
            "Recuperamos los cambios que no llegaste a guardar.",
            "Recuperamos os cambios que non chegaches a gardar.",
          )}
        </p>
      )}
      <section className={styles.group} aria-labelledby="appearance-style">
        <h2 id="appearance-style" className={styles.groupTitle}>
          {t("Estilo visual", "Estilo visual")}
        </h2>
        <div className={styles.card}>
          <Row
            label={t("Viendo", "Vendo")}
            hint={t(
              "Qué modo estás viendo y ajustando ahora.",
              "Que modo estás vendo e axustando agora.",
            )}
          >
            <fieldset className={styles.modes}>
              <legend className={styles.hidden}>
                {t("Modo que estás viendo", "Modo que estás vendo")}
              </legend>
              {(["light", "dark"] as const).map((value) => (
                <ModeThumb
                  key={value}
                  name={modeGroup}
                  mode={value}
                  colors={resolveColors(value, draft)}
                  label={
                    value === "light"
                      ? t("Claro", "Claro")
                      : t("Oscuro", "Escuro")
                  }
                  checked={mode === value}
                  onSelect={() => setMode(value)}
                />
              ))}
            </fieldset>
          </Row>
          <Row
            label={t("Modo inicial", "Modo inicial")}
            hint={t(
              "El que ve quien aún no ha elegido claro u oscuro.",
              "O que ve quen aínda non escolleu claro ou escuro.",
            )}
          >
            <SegmentedControl
              label={t("Modo inicial", "Modo inicial")}
              value={draft.defaultTheme}
              onValueChange={(value) => update({ defaultTheme: value as Mode })}
              options={[
                { value: "light", label: t("Claro", "Claro") },
                { value: "dark", label: t("Oscuro", "Escuro") },
              ]}
            />
          </Row>
        </div>
      </section>

      <section className={styles.group} aria-labelledby="appearance-theme">
        <h2 id="appearance-theme" className={styles.groupTitle}>
          {t("Tema", "Tema")}
        </h2>
        <div className={styles.card}>
          <Row
            label={t("Tema", "Tema")}
            hint={t(
              "Cada tema trae su versión clara y oscura.",
              "Cada tema trae a súa versión clara e escura.",
            )}
          >
            <DropdownMenu
              label={named(themeCatalog[draft.theme].label)}
              icon={<ThemeChip theme={draft.theme} mode={mode} />}
              items={themeIds.map((id) => ({
                label: named(themeCatalog[id].label),
                icon: <ThemeChip theme={id} mode={mode} />,
                current: id === draft.theme,
                // A new theme starts clean: overrides belong to the colours of the theme they were made for.
                onSelect: () => update({ theme: id, light: {}, dark: {} }),
              }))}
            />
          </Row>
          {(["accent", "background", "foreground"] as const).map((key) => (
            <ColorRow
              key={key}
              label={
                {
                  accent: t("Acento", "Acento"),
                  background: t("Fondo", "Fondo"),
                  foreground: t("Texto", "Texto"),
                }[key]
              }
              hint={
                {
                  accent: t(
                    "Botones, enlaces, selección y gráficos.",
                    "Botóns, ligazóns, selección e gráficos.",
                  ),
                  background: t(
                    "Las superficies y los bordes se calculan a partir de él.",
                    "As superficies e os bordos calcúlanse a partir del.",
                  ),
                  foreground: t(
                    "El texto secundario se calcula para mantener el contraste.",
                    "O texto secundario calcúlase para manter o contraste.",
                  ),
                }[key]
              }
              mode={modeName(mode)}
              value={colors[key]}
              custom={key in draft[mode]}
              onChange={(value) => setColor(key, value)}
              onReset={() => setColor(key, null)}
            />
          ))}
          <Row
            label={t("Tipografía", "Tipografía")}
            hint={t("Para toda la interfaz.", "Para toda a interface.")}
          >
            <DropdownMenu
              label={named(fontChoices[draft.font].label)}
              items={(Object.keys(fontChoices) as FontId[]).map((id) => ({
                label: named(fontChoices[id].label),
                icon: (
                  <span
                    className={styles.fontSample}
                    style={{ fontFamily: fontChoices[id].body }}
                    aria-hidden="true"
                  >
                    Aa
                  </span>
                ),
                current: id === draft.font,
                onSelect: () => update({ font: id }),
              }))}
            />
          </Row>
          <Row
            label={t("Esquinas", "Esquinas")}
            hint={t(
              "Botones, campos y tarjetas.",
              "Botóns, campos e tarxetas.",
            )}
          >
            <SegmentedControl
              label={t("Esquinas", "Esquinas")}
              value={draft.corners}
              onValueChange={(value) => update({ corners: value as CornerId })}
              options={(Object.keys(cornerChoices) as CornerId[]).map((id) => ({
                value: id,
                label: named(cornerChoices[id].label),
              }))}
            />
          </Row>
        </div>
        <div className={styles.resetRow}>
          <p className={styles.savedNote} role="status">
            {justSaved && !dirty
              ? t(
                  "Apariencia guardada. Ya la ve todo el municipio.",
                  "Aparencia gardada. Xa a ve todo o municipio.",
                )
              : ""}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              setDraft({ ...defaultAppearance, version: draft.version })
            }
          >
            {t(
              "Restaurar valores predeterminados",
              "Restaurar valores predeterminados",
            )}
          </Button>
        </div>
      </section>

      {dirty && (
        <div
          className={styles.saveBar}
          data-problem={problems.length > 0 || undefined}
          data-pinned-end=""
        >
          {problems.length > 0 ? (
            <div className={styles.problems} role="alert">
              {problems.map(({ mode: of, problem }) => (
                <p key={of}>{problemText(problem, of)}</p>
              ))}
            </div>
          ) : (
            <p className={styles.saveText}>
              {t("Cambios sin guardar", "Cambios sen gardar")}
            </p>
          )}
          {problems.length > 0 ? (
            <div className={styles.saveActions}>
              {discardButton}
              <Button type="button" disabled>
                {t("Guardar", "Gardar")}
              </Button>
            </div>
          ) : (
            <MunicipalForm
              path={`${endpoint(m.id)}/appearance`}
              method="PUT"
              label={t("Guardar", "Gardar")}
              secondary={discardButton}
              body={() => ({
                expectedVersion: draft.version,
                ...settingsOf(draft),
              })}
              onSaved={(result) => {
                const next = result as Appearance;
                setSaved(next);
                setDraft(next);
                store(null);
                setJustSaved(true);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {hint && <span className={styles.rowHint}>{hint}</span>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

/** "Aa" in the theme's accent on its background, the way Codex lists themes. */
function ThemeChip({ theme, mode }: { theme: ThemeId; mode: Mode }) {
  const colors = themeCatalog[theme][mode];
  return (
    <span
      className={styles.chip}
      style={{
        background: colors.background,
        color: colors.accent,
        borderColor: `color-mix(in srgb, ${colors.foreground} 18%, ${colors.background})`,
      }}
      aria-hidden="true"
    >
      Aa
    </span>
  );
}

/** A miniature window drawn in the mode's colours: sidebar, lines of text and an accent button. */
function ModeThumb({
  name,
  mode,
  colors,
  label,
  checked,
  onSelect,
}: {
  name: string;
  mode: Mode;
  colors: ModeColors;
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  const line = (amount: number) =>
    `color-mix(in srgb, ${colors.foreground} ${amount}%, ${colors.background})`;
  return (
    <label className={styles.thumb} data-mode={mode}>
      <input
        type="radio"
        className={styles.thumbInput}
        name={name}
        value={mode}
        checked={checked}
        onChange={onSelect}
      />
      <span
        className={styles.window}
        style={{ background: colors.background, borderColor: line(16) }}
        aria-hidden="true"
      >
        <span className={styles.side} style={{ background: line(6) }} />
        <span className={styles.lines}>
          <span style={{ background: line(70), width: "70%" }} />
          <span style={{ background: line(35), width: "90%" }} />
          <span style={{ background: line(35), width: "55%" }} />
          <span className={styles.pill} style={{ background: colors.accent }} />
        </span>
      </span>
      <span className={styles.thumbLabel}>{label}</span>
    </label>
  );
}

function ColorRow({
  label,
  hint,
  mode,
  value,
  custom,
  onChange,
  onReset,
}: {
  label: string;
  hint: string;
  mode: string;
  value: string;
  custom: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const { t } = usePreferences();
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Row label={label} hint={hint}>
      <div className={styles.color}>
        {custom && (
          <button
            type="button"
            className={styles.reset}
            onClick={onReset}
            aria-label={t(
              `Volver al ${label.toLowerCase()} del tema`,
              `Volver ao ${label.toLowerCase()} do tema`,
            )}
            title={t("Volver al del tema", "Volver ao do tema")}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        )}
        <label className={styles.colorField} htmlFor={id}>
          <span className={styles.swatch} style={{ background: value }}>
            <input
              id={id}
              type="color"
              className={styles.picker}
              value={value}
              aria-label={t(
                `${label} en modo ${mode}`,
                `${label} en modo ${mode}`,
              )}
              onChange={(event) => onChange(event.target.value.toLowerCase())}
            />
          </span>
          <input
            className={styles.hex}
            value={text}
            spellCheck={false}
            maxLength={7}
            aria-label={t(
              `${label} en modo ${mode}, en hexadecimal`,
              `${label} en modo ${mode}, en hexadecimal`,
            )}
            onChange={(event) => {
              const next = event.target.value.trim().toLowerCase();
              setText(next);
              const full = next.startsWith("#") ? next : `#${next}`;
              if (/^#[0-9a-f]{6}$/.test(full)) onChange(full);
            }}
            onBlur={() => setText(value)}
          />
        </label>
      </div>
    </Row>
  );
}
