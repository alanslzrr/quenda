import { useQueryClient } from "@tanstack/react-query";
import { ImageUp, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ApiError, api, type Municipality } from "../../app/api";
import {
  type Branding,
  type LogoVariant,
  logoUrl,
  municipalityKey,
  useBranding,
} from "../../app/branding";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Button } from "../../ui/button/button";
import { Input } from "../../ui/input/input";
import styles from "./appearance.module.css";
import { endpoint, MunicipalForm, useMunicipality } from "./shared";

const accepted = ["image/png", "image/jpeg", "image/webp"];
const maximumBytes = 2 * 1024 * 1024;

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(
        String(reader.result).slice(String(reader.result).indexOf(",") + 1),
      );
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Name and logo of the municipality: each saves on its own, because each changes what everyone sees at once. */
export function MunicipalIdentity() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const { account } = useSession();
  const client = useQueryClient();
  const branding = useBranding(m.id);
  // The public record is updated in place (no extra request); navigation and municipal context are read again
  // so every screen shows the new name.
  const settle = async (next: Branding) => {
    client.setQueryData<Municipality>(municipalityKey(m.id), (current) =>
      current
        ? {
            ...current,
            name: next.name,
            officialName: next.officialName,
            branding: { version: next.version, logos: next.logos },
          }
        : current,
    );
    await Promise.all(
      ["navigation", "municipal-context"].map((key) =>
        client.invalidateQueries({
          queryKey: ["private", account?.accountId, key],
        }),
      ),
    );
  };
  return (
    <section className={styles.group} aria-labelledby="appearance-identity">
      <h2 id="appearance-identity" className={styles.groupTitle}>
        {t("Identidad", "Identidade")}
      </h2>
      {branding.isPending ? (
        <Loading />
      ) : !branding.data ? (
        <Failure error={branding.error} retry={() => void branding.refetch()} />
      ) : (
        <div className={styles.card}>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.rowLabel}>
                {t("Nombre del municipio", "Nome do municipio")}
              </span>
              <span className={styles.rowHint}>
                {t(
                  `Aparece en toda la aplicación. Nombre oficial de alta: ${branding.data.officialName}.`,
                  `Aparece en toda a aplicación. Nome oficial de alta: ${branding.data.officialName}.`,
                )}
              </span>
            </div>
            <div className={styles.nameForm}>
              <MunicipalForm
                key={branding.data.version}
                path={`${endpoint(m.id)}/branding/name`}
                method="PUT"
                label={t("Guardar nombre", "Gardar nome")}
                body={(data) => ({
                  expectedVersion: branding.data.version,
                  name: String(data.get("name") ?? ""),
                })}
                onSaved={(result) => settle(result as Branding)}
              >
                <Input
                  label={t("Nombre visible", "Nome visible")}
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={branding.data.name}
                  autoComplete="off"
                />
              </MunicipalForm>
            </div>
          </div>
          <LogoRow
            variant="light"
            branding={branding.data}
            onChanged={settle}
          />
          {branding.data.logos.light && (
            <LogoRow
              variant="dark"
              branding={branding.data}
              onChanged={settle}
            />
          )}
        </div>
      )}
    </section>
  );
}

function LogoRow({
  variant,
  branding,
  onChanged,
}: {
  variant: LogoVariant;
  branding: Branding;
  onChanged: (next: Branding) => Promise<void>;
}) {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [problem, setProblem] = useState<unknown>();
  const present = branding.logos[variant];
  const path = `${endpoint(m.id)}/branding/logos/${variant}`;

  async function run(kind: "upload" | "remove", work: () => Promise<Branding>) {
    setProblem(undefined);
    setBusy(kind);
    try {
      await onChanged(await work());
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  }
  function upload(file: File | undefined) {
    if (!file) return;
    if (!accepted.includes(file.type) || file.size > maximumBytes) {
      setProblem(
        new ApiError(
          400,
          "LOGO_INVALID",
          t(
            "Elige una imagen PNG, JPG o WebP de hasta 2 MB. No se admiten SVG.",
            "Escolle unha imaxe PNG, JPG ou WebP de ata 2 MB. Non se admiten SVG.",
          ),
        ),
      );
      return;
    }
    void run("upload", async () =>
      api<Branding>(
        path,
        {
          method: "PUT",
          body: JSON.stringify({
            expectedVersion: branding.version,
            image: await readAsBase64(file),
          }),
        },
        locale,
      ),
    );
  }

  const label =
    variant === "light"
      ? t("Logo", "Logo")
      : t("Logo para fondo oscuro", "Logo para fondo escuro");
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowHint}>
          {variant === "light"
            ? t(
                "PNG, JPG o WebP de hasta 2 MB, mejor con fondo transparente. Se muestra en el menú, en la cabecera pública y en la pestaña del navegador.",
                "PNG, JPG ou WebP de ata 2 MB, mellor con fondo transparente. Móstrase no menú, na cabeceira pública e na lapela do navegador.",
              )
            : t(
                "Opcional. Si no lo subes, en modo oscuro se usa el logo principal.",
                "Opcional. Se non o subes, no modo escuro úsase o logo principal.",
              )}
        </span>
        {problem !== undefined && <Failure error={problem} />}
      </div>
      <div className={styles.logoControl}>
        {present && (
          <span
            className={styles.logoPreview}
            data-variant={variant}
            aria-hidden="true"
          >
            <img src={logoUrl(m.id, variant, branding.version)} alt="" />
          </span>
        )}
        <input
          ref={input}
          id={inputId}
          className={styles.fileInput}
          type="file"
          accept={accepted.join(",")}
          aria-label={label}
          onChange={(event) => {
            upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busy === "upload"}
          disabled={busy !== null}
          onClick={() => input.current?.click()}
        >
          <ImageUp size={16} aria-hidden="true" />
          {present ? t("Cambiar", "Cambiar") : t("Subir", "Subir")}
        </Button>
        {present && (
          <Button
            type="button"
            variant="danger-ghost"
            size="sm"
            loading={busy === "remove"}
            disabled={busy !== null}
            aria-label={t(
              `Quitar ${label.toLowerCase()}`,
              `Quitar ${label.toLowerCase()}`,
            )}
            onClick={() =>
              void run("remove", () =>
                api<Branding>(
                  `${path}?expectedVersion=${branding.version}`,
                  { method: "DELETE" },
                  locale,
                ),
              )
            }
          >
            <Trash2 size={16} aria-hidden="true" />
            {t("Quitar", "Quitar")}
          </Button>
        )}
      </div>
    </div>
  );
}
