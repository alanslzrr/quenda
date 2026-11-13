import { Minus, Move, Plus } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useId, useRef } from "react";
import { usePreferences } from "../../app/preferences-provider";
import {
  type Crop,
  clampCrop,
  framePlacement,
  maximumZoom,
  pan,
} from "./photo-crop";
import styles from "./photo-manager.module.css";

export interface Picture {
  url: string;
  width: number;
  height: number;
}

/** The picture drawn so that the crop fills a 3:2 frame of any size. */
export function Framed({ picture, crop }: { picture: Picture; crop: Crop }) {
  return (
    <img
      className={styles.framed}
      src={picture.url}
      alt=""
      draggable={false}
      style={framePlacement(picture.width, picture.height, crop)}
    />
  );
}

/**
 * A fixed 3:2 frame over the picture: drag it, or use the arrows and + / −,
 * to choose what is published. The frame is exactly what the public will see.
 */
export function PhotoCropper({
  picture,
  crop,
  onChange,
}: {
  picture: Picture;
  crop: Crop;
  onChange: (crop: Crop) => void;
}) {
  const { t } = usePreferences();
  const hint = useId();
  const zoomId = useId();
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const { width, height } = picture;
  const limit = maximumZoom(width, height);
  const set = (next: Crop) => onChange(clampCrop(width, height, next));
  const zoomBy = (factor: number) => set({ ...crop, zoom: crop.zoom * factor });
  const down = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || from.id !== event.pointerId) return;
    drag.current = { ...from, x: event.clientX, y: event.clientY };
    onChange(
      pan(
        width,
        height,
        crop,
        event.clientX - from.x,
        event.clientY - from.y,
        event.currentTarget.getBoundingClientRect().width,
      ),
    );
  };
  const end = () => {
    drag.current = null;
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const frame = event.currentTarget.getBoundingClientRect().width || 1;
    const step = frame / 20;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const delta = moves[event.key];
    if (delta) {
      event.preventDefault();
      onChange(pan(width, height, crop, delta[0], delta[1], frame));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.15);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(1 / 1.15);
    }
  };
  return (
    <div className={styles.cropper}>
      <div
        className={styles.frame}
        role="application"
        aria-roledescription={t("encuadre", "encadre")}
        aria-label={t(
          "Encuadre de la foto. Muévelo con las flechas y acércalo o aléjalo con + y −.",
          "Encadre da foto. Móveo coas frechas e achégao ou afástao con + e −.",
        )}
        aria-describedby={hint}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the frame is moved with the arrow keys and zoomed with + and −, as its label says.
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={key}
      >
        <Framed picture={picture} crop={crop} />
        <span className={styles.grid} aria-hidden="true" />
        <span className={styles.dragHint} aria-hidden="true">
          <Move size={14} />
          {t("Arrastra para encuadrar", "Arrastra para encadrar")}
        </span>
      </div>
      <p id={hint} className={styles.hint}>
        {t(
          "Lo que queda dentro del marco es exactamente lo que se publicará.",
          "O que queda dentro do marco é exactamente o que se publicará.",
        )}
      </p>
      <div className={styles.zoom}>
        <label htmlFor={zoomId}>{t("Acercar", "Achegar")}</label>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.15)}
          disabled={crop.zoom <= 1}
          aria-label={t("Alejar", "Afastar")}
          title={t("Alejar", "Afastar")}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <input
          id={zoomId}
          type="range"
          min={1}
          max={limit}
          step={0.01}
          value={crop.zoom}
          disabled={limit <= 1}
          onChange={(event) =>
            set({ ...crop, zoom: Number(event.currentTarget.value) })
          }
        />
        <button
          type="button"
          onClick={() => zoomBy(1.15)}
          disabled={crop.zoom >= limit}
          aria-label={t("Acercar", "Achegar")}
          title={t("Acercar", "Achegar")}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
