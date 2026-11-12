import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  Pencil,
  RectangleHorizontal,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { type DragEvent, type FormEvent, useId, useRef, useState } from "react";
import { ApiError, api } from "../../app/api";
import { Failure } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Alert } from "../../ui/alert/alert";
import { Button } from "../../ui/button/button";
import { Dialog, DialogContent } from "../../ui/dialog/dialog";
import { DropdownMenu } from "../../ui/dropdown-menu/dropdown-menu";
import { Input } from "../../ui/input/input";
import { type CatalogPhoto, photoAlt } from "../catalog/photos";
import {
  type Crop,
  centred,
  cropRect,
  largeEnough,
  outputSize,
  recommendedWidth,
} from "./photo-crop";
import { Framed, PhotoCropper, type Picture } from "./photo-cropper";
import styles from "./photo-manager.module.css";

export const maximumPhotos = 6;
const accepted = ["image/jpeg", "image/png", "image/webp"];
/** Originals straight from a phone or camera; only the framed image is uploaded. */
const maximumFileBytes = 30 * 1024 * 1024;

type Kind = "facility" | "unit";
interface Saved {
  photos: CatalogPhoto[];
}

/** Always on screen: what makes a photo work in the catalog. */
function Requirements({ kind }: { kind: Kind }) {
  const { t } = usePreferences();
  return (
    <ul className={styles.requirements}>
      <li>
        <RectangleHorizontal size={16} aria-hidden="true" />
        {t(
          `Fotos horizontales (apaisadas), de al menos ${recommendedWidth} píxeles de ancho. Se publican en formato 3:2.`,
          `Fotos horizontais (apaisadas), de polo menos ${recommendedWidth} píxeles de ancho. Publícanse en formato 3:2.`,
        )}
      </li>
      <li>
        {kind === "facility"
          ? t(
              "Muestra la instalación: el acceso, el exterior o una vista general.",
              "Mostra a instalación: o acceso, o exterior ou unha vista xeral.",
            )
          : t(
              "Muestra el espacio tal como se reserva: la pista, la sala o la piscina.",
              "Mostra o espazo tal como se reserva: a pista, a sala ou a piscina.",
            )}
      </li>
      <li>
        {t(
          "Sin personas reconocibles ni matrículas. Se eliminan la ubicación y los demás datos ocultos del archivo.",
          "Sen persoas recoñecibles nin matrículas. Elimínanse a localización e os demais datos ocultos do ficheiro.",
        )}
      </li>
    </ul>
  );
}

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

/** Draws the framed part of the picture at its own resolution and encodes it as JPEG. */
async function frameImage(file: File, picture: Picture, crop: Crop) {
  const bitmap = await createImageBitmap(file);
  try {
    const rect = cropRect(picture.width, picture.height, crop);
    const size = outputSize(rect);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      size.width,
      size.height,
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) throw new Error("Encoding failed");
    return readAsBase64(blob);
  } finally {
    bitmap.close();
  }
}

/**
 * A reduced copy for the frame and the preview, as a data: URL: the content
 * security policy admits images only from the origin and data: URLs. The
 * upload is drawn later from the original file at full resolution.
 */
function previewOf(bitmap: ImageBitmap) {
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function AltFields({ photo }: { photo?: CatalogPhoto }) {
  const { t } = usePreferences();
  return (
    <div className={styles.altFields}>
      <Input
        label={t("Descripción en gallego", "Descrición en galego")}
        name="altGl"
        required
        maxLength={250}
        autoComplete="off"
        defaultValue={photo?.alt.gl ?? ""}
        description={t(
          "Lo que se ve, para quien no puede verla. Por ejemplo: «Pista de pádel cuberta con paredes de vidro».",
          "O que se ve, para quen non a pode ver. Por exemplo: «Pista de pádel cuberta con paredes de vidro».",
        )}
      />
      <Input
        label={t("Descripción en castellano", "Descrición en castelán")}
        name="altEs"
        required
        maxLength={250}
        autoComplete="off"
        defaultValue={photo?.alt.es ?? ""}
        description={t(
          "Por ejemplo: «Pista de pádel cubierta con paredes de cristal».",
          "Por exemplo: «Pista de pádel cubierta con paredes de cristal».",
        )}
      />
    </div>
  );
}
const altBody = (form: HTMLFormElement) => {
  const data = new FormData(form);
  return {
    gl: String(data.get("altGl") ?? "").trim(),
    es: String(data.get("altEs") ?? "").trim(),
  };
};

/** Choose, frame, preview and describe a photo, then upload it. */
function AddPhoto({
  path,
  kind,
  name,
  onSaved,
}: {
  path: string;
  kind: Kind;
  name: string;
  onSaved: (saved: Saved) => void;
}) {
  const { locale, t } = usePreferences();
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function choose(chosen: File | undefined) {
    setProblem(null);
    setError(undefined);
    if (!chosen) return;
    if (!accepted.includes(chosen.type))
      return setProblem(
        t(
          "Ese archivo no es una foto en JPG, PNG o WebP.",
          "Ese ficheiro non é unha foto en JPG, PNG ou WebP.",
        ),
      );
    if (chosen.size > maximumFileBytes)
      return setProblem(
        t(
          "La foto pesa más de 30 MB. Elige otra o redúcela antes.",
          "A foto pesa máis de 30 MB. Escolle outra ou redúcea antes.",
        ),
      );
    let size: { width: number; height: number };
    let preview: string;
    try {
      const bitmap = await createImageBitmap(chosen);
      size = { width: bitmap.width, height: bitmap.height };
      preview = previewOf(bitmap);
      bitmap.close();
    } catch {
      return setProblem(
        t(
          "No se ha podido abrir la foto. Prueba con otro archivo.",
          "Non se puido abrir a foto. Proba con outro ficheiro.",
        ),
      );
    }
    if (!largeEnough(size.width, size.height))
      return setProblem(
        t(
          `La foto es demasiado pequeña (${size.width} × ${size.height} píxeles). Usa una foto horizontal de al menos ${recommendedWidth} píxeles de ancho.`,
          `A foto é demasiado pequena (${size.width} × ${size.height} píxeles). Usa unha foto horizontal de polo menos ${recommendedWidth} píxeles de ancho.`,
        ),
      );
    setFile(chosen);
    setPicture({ url: preview, ...size });
    setCrop(centred(size.width, size.height));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !picture || !crop || busy) return;
    const alt = altBody(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const image = await frameImage(file, picture, crop);
      onSaved(
        await api<Saved>(
          `${path}/photos`,
          { method: "POST", body: JSON.stringify({ image, alt }) },
          locale,
        ),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  };
  const portrait = picture && picture.width / picture.height < 1.3;
  if (!picture || !crop)
    return (
      <div className={styles.pick}>
        <label
          htmlFor={inputId}
          className={styles.dropzone}
          data-dragging={dragging || undefined}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <Upload size={28} strokeWidth={1.5} aria-hidden="true" />
          <span className={styles.dropTitle}>
            {t("Elige una foto", "Escolle unha foto")}
          </span>
          <span className={styles.dropText}>
            {t(
              "Arrastra la foto aquí o pulsa para buscarla. JPG, PNG o WebP.",
              "Arrastra a foto aquí ou preme para buscala. JPG, PNG ou WebP.",
            )}
          </span>
        </label>
        <input
          id={inputId}
          className={styles.fileInput}
          type="file"
          accept={accepted.join(",")}
          onChange={(event) => {
            void choose(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        {problem && <Alert tone="danger" title={problem} role="alert" />}
        <Requirements kind={kind} />
      </div>
    );
  return (
    <form className={styles.compose} onSubmit={submit}>
      {portrait && (
        <Alert
          tone="warning"
          title={t("Esta foto no es horizontal", "Esta foto non é horizontal")}
        >
          <p>
            {t(
              "Solo se publicará la franja horizontal que quede dentro del marco. Para un mejor resultado, usa una foto horizontal.",
              "Só se publicará a franxa horizontal que quede dentro do marco. Para un mellor resultado, usa unha foto horizontal.",
            )}
          </p>
        </Alert>
      )}
      <PhotoCropper picture={picture} crop={crop} onChange={setCrop} />
      <section
        className={styles.preview}
        aria-labelledby={`${inputId}-preview`}
      >
        <h3 id={`${inputId}-preview`}>
          {t("Así se verá en el listado", "Así se verá no listado")}
        </h3>
        <div className={styles.previewRow} aria-hidden="true">
          <span className={styles.previewThumb}>
            <Framed picture={picture} crop={crop} />
          </span>
          <span className={styles.previewName}>{name}</span>
        </div>
      </section>
      <fieldset className={styles.altSet} disabled={busy}>
        <legend>{t("Descripción de la foto", "Descrición da foto")}</legend>
        <AltFields />
      </fieldset>
      {error !== undefined && <Failure error={error} />}
      <div className={styles.composeActions}>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setPicture(null);
            setFile(null);
            setCrop(null);
          }}
        >
          {t("Elegir otra foto", "Escoller outra foto")}
        </Button>
        <Button type="submit" loading={busy} disabled={busy}>
          <ImagePlus size={16} aria-hidden="true" />
          {t("Añadir foto", "Engadir foto")}
        </Button>
      </div>
    </form>
  );
}

function Describe({
  path,
  photo,
  onSaved,
}: {
  path: string;
  photo: CatalogPhoto;
  onSaved: (saved: Saved) => void;
}) {
  const { locale, t } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <form
      className={styles.compose}
      onSubmit={async (event) => {
        event.preventDefault();
        const alt = altBody(event.currentTarget);
        setBusy(true);
        setError(undefined);
        try {
          onSaved(
            await api<Saved>(
              `${path}/photos/${photo.id}`,
              { method: "PATCH", body: JSON.stringify({ alt }) },
              locale,
            ),
          );
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className={styles.altSet} disabled={busy}>
        <AltFields photo={photo} />
      </fieldset>
      {error !== undefined && <Failure error={error} />}
      <div className={styles.composeActions}>
        <Button type="submit" loading={busy} disabled={busy}>
          {t("Guardar descripción", "Gardar descrición")}
        </Button>
      </div>
    </form>
  );
}

type Open =
  | { action: "add" }
  | { action: "describe" | "remove"; photo: CatalogPhoto }
  | null;

/**
 * The photos of a facility or unit for staff: add with framing and preview,
 * reorder (the first is the cover), describe and remove.
 */
export function PhotoManager({
  path,
  kind,
  name,
  photos: initial,
}: {
  /** The administrative path of the facility or unit. */
  path: string;
  kind: Kind;
  name: string;
  photos: CatalogPhoto[];
}) {
  const { locale, t } = usePreferences();
  const { account } = useSession();
  const client = useQueryClient();
  const headingId = useId();
  const [photos, setPhotos] = useState(initial);
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [status, setStatus] = useState("");
  const returnFocus = useRef<HTMLButtonElement>(null);

  const saved = (result: Saved, message: string) => {
    setPhotos(result.photos);
    setOpen(null);
    setStatus(message);
    // The resource read carries the photos too; keep it in step with what was saved.
    void client.invalidateQueries({
      queryKey: ["private", account?.accountId, "municipal", path],
    });
  };
  async function order(ids: string[], message: string) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      saved(
        await api<Saved>(
          `${path}/photos/order`,
          { method: "PUT", body: JSON.stringify({ photoIds: ids }) },
          locale,
        ),
        message,
      );
    } catch (failure) {
      setError(failure);
      // Someone else may have changed the list: show the current one.
      if (failure instanceof ApiError && failure.status === 409)
        void api<{ photos: CatalogPhoto[] }>(path, {}, locale).then(
          (resource) => setPhotos(resource.photos),
          () => undefined,
        );
    } finally {
      setBusy(false);
    }
  }
  const moved = (from: number, to: number) => {
    const ids = photos.map((photo) => photo.id);
    const [id] = ids.splice(from, 1);
    if (id) ids.splice(to, 0, id);
    return ids;
  };
  async function remove(photo: CatalogPhoto) {
    setBusy(true);
    setError(undefined);
    try {
      saved(
        await api<Saved>(
          `${path}/photos/${photo.id}`,
          { method: "DELETE" },
          locale,
        ),
        t("Foto eliminada.", "Foto eliminada."),
      );
    } catch (failure) {
      setError(failure);
      setOpen(null);
    } finally {
      setBusy(false);
    }
  }
  const image = (id: string) => `${path}/photos/${id}/small`;
  const full = photos.length >= maximumPhotos;
  return (
    <section className={styles.manager} aria-labelledby={headingId}>
      <div className={styles.head}>
        <div>
          <h2 id={headingId}>{t("Fotografías", "Fotografías")}</h2>
          <p>
            {kind === "facility"
              ? t(
                  `Las verá la ciudadanía al elegir la instalación. Hasta ${maximumPhotos} fotos; la primera es la portada del listado.`,
                  `Veraas a cidadanía ao escoller a instalación. Ata ${maximumPhotos} fotos; a primeira é a portada do listado.`,
                )
              : t(
                  `Las verá la ciudadanía al elegir el espacio. Hasta ${maximumPhotos} fotos; la primera es la portada del listado. Sin fotos propias, se muestran las de la instalación.`,
                  `Veraas a cidadanía ao escoller o espazo. Ata ${maximumPhotos} fotos; a primeira é a portada do listado. Sen fotos propias, móstranse as da instalación.`,
                )}
          </p>
        </div>
        {photos.length > 0 && (
          <Button
            ref={returnFocus}
            variant="secondary"
            disabled={full}
            onClick={() => setOpen({ action: "add" })}
          >
            <ImagePlus size={16} aria-hidden="true" />
            {t("Añadir foto", "Engadir foto")}
          </Button>
        )}
      </div>
      {photos.length > 0 && <Requirements kind={kind} />}
      <p role="status" className={styles.status}>
        {status}
      </p>
      {error !== undefined && <Failure error={error} />}
      {full && (
        <p className={styles.note}>
          {t(
            `Ya hay ${maximumPhotos} fotos. Elimina una para añadir otra.`,
            `Xa hai ${maximumPhotos} fotos. Elimina unha para engadir outra.`,
          )}
        </p>
      )}
      {photos.length === 0 ? (
        <button
          type="button"
          className={styles.empty}
          onClick={() => setOpen({ action: "add" })}
        >
          <ImagePlus size={28} strokeWidth={1.5} aria-hidden="true" />
          <span className={styles.dropTitle}>
            {t("Añade la primera foto", "Engade a primeira foto")}
          </span>
          <span className={styles.dropText}>
            {t(
              `Usa una foto horizontal de al menos ${recommendedWidth} píxeles de ancho.`,
              `Usa unha foto horizontal de polo menos ${recommendedWidth} píxeles de ancho.`,
            )}
          </span>
        </button>
      ) : (
        <ol
          className={styles.list}
          aria-label={t(
            "Fotos, en el orden en que se muestran",
            "Fotos, na orde en que se mostran",
          )}
        >
          {photos.map((photo, index) => (
            <li key={photo.id} className={styles.card}>
              <span className={styles.cardImage}>
                <img
                  src={image(photo.id)}
                  width={photo.width}
                  height={photo.height}
                  alt={photoAlt(photo, locale)}
                  loading="lazy"
                  decoding="async"
                />
                {index === 0 && (
                  <span className={styles.cover}>
                    {t("Portada", "Portada")}
                  </span>
                )}
              </span>
              <span className={styles.cardText}>{photoAlt(photo, locale)}</span>
              <span className={styles.cardFoot}>
                <span className={styles.position}>
                  {t(
                    `Foto ${index + 1} de ${photos.length}`,
                    `Foto ${index + 1} de ${photos.length}`,
                  )}
                </span>
                <DropdownMenu
                  label={t("Opciones", "Opcións")}
                  triggerProps={{
                    "aria-label": t(
                      `Opciones de la foto ${index + 1}`,
                      `Opcións da foto ${index + 1}`,
                    ),
                    disabled: busy,
                  }}
                  items={[
                    {
                      label: t("Usar como portada", "Usar como portada"),
                      icon: <Star size={16} aria-hidden="true" />,
                      disabled: index === 0,
                      onSelect: () =>
                        void order(
                          moved(index, 0),
                          t("Portada cambiada.", "Portada cambiada."),
                        ),
                    },
                    {
                      label: t("Mover antes", "Mover antes"),
                      icon: <ArrowLeft size={16} aria-hidden="true" />,
                      disabled: index === 0,
                      onSelect: () =>
                        void order(
                          moved(index, index - 1),
                          t(
                            `Foto movida al puesto ${index}.`,
                            `Foto movida ao posto ${index}.`,
                          ),
                        ),
                    },
                    {
                      label: t("Mover después", "Mover despois"),
                      icon: <ArrowRight size={16} aria-hidden="true" />,
                      disabled: index === photos.length - 1,
                      onSelect: () =>
                        void order(
                          moved(index, index + 1),
                          t(
                            `Foto movida al puesto ${index + 2}.`,
                            `Foto movida ao posto ${index + 2}.`,
                          ),
                        ),
                    },
                    {
                      label: t("Editar descripción", "Editar descrición"),
                      icon: <Pencil size={16} aria-hidden="true" />,
                      separatorBefore: true,
                      onSelect: () => setOpen({ action: "describe", photo }),
                    },
                    {
                      label: t("Eliminar", "Eliminar"),
                      icon: <Trash2 size={16} aria-hidden="true" />,
                      destructive: true,
                      onSelect: () => setOpen({ action: "remove", photo }),
                    },
                  ]}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
      <Dialog
        open={open?.action === "add"}
        onOpenChange={(value) => !value && setOpen(null)}
      >
        <DialogContent
          className={styles.dialog}
          closeLabel={t("Cerrar", "Pechar")}
          title={t("Añadir foto", "Engadir foto")}
          description={t(
            "Elige una foto horizontal, encuádrala y descríbela.",
            "Escolle unha foto horizontal, encádraa e descríbea.",
          )}
        >
          <AddPhoto
            path={path}
            kind={kind}
            name={name}
            onSaved={(result) =>
              saved(result, t("Foto añadida.", "Foto engadida."))
            }
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={open?.action === "describe"}
        onOpenChange={(value) => !value && setOpen(null)}
      >
        <DialogContent
          closeLabel={t("Cerrar", "Pechar")}
          title={t("Editar descripción", "Editar descrición")}
        >
          {open?.action === "describe" && (
            <Describe
              path={path}
              photo={open.photo}
              onSaved={(result) =>
                saved(result, t("Descripción guardada.", "Descrición gardada."))
              }
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={open?.action === "remove"}
        onOpenChange={(value) => !value && setOpen(null)}
      >
        <DialogContent
          closeLabel={t("Cerrar", "Pechar")}
          title={t("¿Eliminar esta foto?", "Eliminar esta foto?")}
          description={t(
            "Dejará de verse en el catálogo público. No se puede deshacer.",
            "Deixará de verse no catálogo público. Non se pode desfacer.",
          )}
        >
          {open?.action === "remove" && (
            <div className={styles.compose}>
              <span className={styles.removePreview}>
                <img
                  src={image(open.photo.id)}
                  width={open.photo.width}
                  height={open.photo.height}
                  alt={photoAlt(open.photo, locale)}
                />
              </span>
              <div className={styles.composeActions}>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setOpen(null)}
                >
                  {t("Cancelar", "Cancelar")}
                </Button>
                <Button
                  variant="danger"
                  loading={busy}
                  disabled={busy}
                  onClick={() => void remove(open.photo)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  {t("Eliminar foto", "Eliminar foto")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
