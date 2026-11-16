import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ChevronLeft,
  ChevronRight,
  Images,
  type LucideIcon,
  X,
} from "lucide-react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePreferences } from "../../app/preferences-provider";
import styles from "./photo-gallery.module.css";
import {
  type CatalogPhoto,
  type PhotoSource,
  photoAlt,
  photoSrcSet,
} from "./photos";

/**
 * The photos of a facility or unit: the cover large and, on wider screens, the
 * next two beside it. Any photo opens the viewer at that photo.
 */
export function PhotoGallery({
  photos,
  source,
  label,
}: {
  photos: CatalogPhoto[];
  source: PhotoSource;
  /** What the photos show, such as the unit name; it titles the viewer. */
  label: string;
}) {
  const { locale, t } = usePreferences();
  const [open, setOpen] = useState<number | null>(null);
  if (!photos.length) return null;
  const count = photos.length;
  const shown = photos.slice(0, 3);
  const name = (index: number) => {
    const photo = photos[index];
    const alt = photo ? photoAlt(photo, locale) : "";
    return count === 1
      ? t(`Ampliar la foto: ${alt}`, `Ampliar a foto: ${alt}`)
      : t(
          `Ampliar la foto ${index + 1} de ${count}: ${alt}`,
          `Ampliar a foto ${index + 1} de ${count}: ${alt}`,
        );
  };
  return (
    <section
      className={styles.gallery}
      data-count={Math.min(count, 3)}
      aria-label={t(`Fotos de ${label}`, `Fotos de ${label}`)}
    >
      {shown.map((photo, index) => (
        <button
          key={photo.id}
          type="button"
          className={styles.tile}
          data-main={index === 0 || undefined}
          aria-label={name(index)}
          onClick={() => setOpen(index)}
        >
          <img
            src={source(photo.id, index === 0 ? "large" : "small")}
            srcSet={photoSrcSet(source, photo)}
            sizes={
              index === 0
                ? "(max-width: 560px) 100vw, 600px"
                : "(max-width: 560px) 1px, 300px"
            }
            width={photo.width}
            height={photo.height}
            alt=""
            loading={index === 0 ? "eager" : "lazy"}
            decoding="async"
          />
          {index === 2 && count > 3 && (
            <span className={styles.more} aria-hidden="true">
              +{count - 3}
            </span>
          )}
        </button>
      ))}
      {count > 1 && (
        <button type="button" className={styles.all} onClick={() => setOpen(0)}>
          <Images size={16} aria-hidden="true" />
          {t(`Ver las ${count} fotos`, `Ver as ${count} fotos`)}
        </button>
      )}
      <PhotoViewer
        photos={photos}
        source={source}
        label={label}
        index={open}
        onIndexChange={setOpen}
      />
    </section>
  );
}

function RoundButton({
  icon: Icon,
  label,
  className,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  className: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={22} aria-hidden="true" />
    </button>
  );
}

/**
 * Brings the active thumbnail inside the strip's padding. Only the strip scrolls,
 * so the page behind the viewer never moves.
 */
function revealActive(strip: HTMLElement, behavior: ScrollBehavior) {
  const thumb = strip.querySelector<HTMLElement>("[aria-current]");
  if (!thumb) return;
  const frame = strip.getBoundingClientRect();
  const box = thumb.getBoundingClientRect();
  const style = getComputedStyle(strip);
  const start = frame.left + Number.parseFloat(style.paddingLeft);
  const end = frame.right - Number.parseFloat(style.paddingRight);
  const shift =
    box.left < start ? box.left - start : box.right > end ? box.right - end : 0;
  if (shift) strip.scrollBy({ left: shift, behavior });
}

/** Full-screen viewer: arrows, keyboard and swipe move between photos; the description is the caption. */
export function PhotoViewer({
  photos,
  source,
  label,
  index,
  onIndexChange,
}: {
  photos: CatalogPhoto[];
  source: PhotoSource;
  label: string;
  index: number | null;
  onIndexChange: (index: number | null) => void;
}) {
  const { locale, t } = usePreferences();
  const start = useRef<{ x: number; y: number } | null>(null);
  const strip = useRef<HTMLUListElement | null>(null);
  // Opening places the active thumbnail at once: easing there from the start would read as a jump.
  const placeStrip = useCallback((node: HTMLUListElement | null) => {
    strip.current = node;
    if (node) revealActive(node, "instant");
  }, []);
  // Moving between photos keeps the active thumbnail in view; the strip's CSS decides whether it eases.
  useEffect(() => {
    if (index !== null && strip.current) revealActive(strip.current, "auto");
  }, [index]);
  const count = photos.length;
  const current = index === null ? undefined : photos[index];
  const go = (step: number) => {
    if (index === null || count < 2) return;
    onIndexChange((index + step + count) % count);
  };
  const press = (event: PointerEvent) => {
    start.current = { x: event.clientX, y: event.clientY };
  };
  const release = (event: PointerEvent) => {
    const from = start.current;
    start.current = null;
    if (!from) return;
    const dx = event.clientX - from.x;
    // A clear horizontal swipe; a vertical scroll or a tap does nothing.
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(event.clientY - from.y))
      go(dx < 0 ? 1 : -1);
  };
  return (
    <DialogPrimitive.Root
      open={index !== null}
      onOpenChange={(open) => !open && onIndexChange(null)}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.backdrop} />
        <DialogPrimitive.Content
          className={styles.viewer}
          aria-describedby={undefined}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") go(1);
            else if (event.key === "ArrowLeft") go(-1);
          }}
        >
          <div className={styles.bar}>
            <DialogPrimitive.Title className={styles.viewerTitle}>
              {label}
            </DialogPrimitive.Title>
            {count > 1 && index !== null && (
              <p className={styles.counter} aria-live="polite">
                {t(
                  `Foto ${index + 1} de ${count}`,
                  `Foto ${index + 1} de ${count}`,
                )}
              </p>
            )}
            <DialogPrimitive.Close
              className={styles.close}
              aria-label={t("Cerrar", "Pechar")}
              title={t("Cerrar", "Pechar")}
            >
              <X size={20} aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          {current && (
            <figure
              className={styles.stage}
              onPointerDown={press}
              onPointerUp={release}
              onPointerCancel={() => {
                start.current = null;
              }}
            >
              <img
                key={current.id}
                src={source(current.id, "large")}
                srcSet={photoSrcSet(source, current)}
                sizes="100vw"
                width={current.width}
                height={current.height}
                alt={photoAlt(current, locale)}
                draggable={false}
              />
              <figcaption>{photoAlt(current, locale)}</figcaption>
            </figure>
          )}
          {count > 1 && (
            <>
              <RoundButton
                icon={ChevronLeft}
                className={`${styles.step} ${styles.previous}`}
                label={t("Foto anterior", "Foto anterior")}
                onClick={() => go(-1)}
              />
              <RoundButton
                icon={ChevronRight}
                className={`${styles.step} ${styles.next}`}
                label={t("Foto siguiente", "Foto seguinte")}
                onClick={() => go(1)}
              />
              <ul ref={placeStrip} className={styles.strip}>
                {photos.map((photo, position) => (
                  <li key={photo.id}>
                    <button
                      type="button"
                      aria-current={position === index || undefined}
                      aria-label={t(
                        `Ver la foto ${position + 1}: ${photoAlt(photo, locale)}`,
                        `Ver a foto ${position + 1}: ${photoAlt(photo, locale)}`,
                      )}
                      onClick={() => onIndexChange(position)}
                    >
                      <img
                        src={source(photo.id, "small")}
                        width={photo.width}
                        height={photo.height}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The cover of a facility or unit beside its name in a list. Without a photo a
 * neutral tile with an icon keeps the list even.
 */
export function PhotoThumb({
  photo,
  source,
  icon: Icon,
}: {
  photo: CatalogPhoto | undefined;
  source: PhotoSource;
  icon: LucideIcon;
}) {
  return (
    <span className={styles.thumb} aria-hidden="true">
      {photo ? (
        <img
          src={source(photo.id, "small")}
          width={photo.width}
          height={photo.height}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : (
        <Icon size={22} strokeWidth={1.5} />
      )}
    </span>
  );
}
