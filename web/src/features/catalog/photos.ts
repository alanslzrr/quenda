import { type Locale, type Localized, localized } from "./profile";

/** A photograph of a facility or unit. Every one is a 3:2 landscape image. */
export interface CatalogPhoto {
  id: string;
  alt: Localized;
  width: number;
  height: number;
}
export type PhotoSize = "large" | "small";
/** Where the bytes of a photo live: the public catalog or the administrative editor. */
export type PhotoSource = (id: string, size: PhotoSize) => string;

export const publicPhotos =
  (tenantId: string): PhotoSource =>
  (id, size) =>
    `/api/public/municipalities/${tenantId}/photos/${id}/${size}`;

export const photoAlt = (photo: CatalogPhoto, locale: Locale) =>
  localized(photo.alt, locale) ?? "";

/** Responsive candidates: the small image is 600 px wide, the large one up to 1500 px. */
export const photoSrcSet = (source: PhotoSource, photo: CatalogPhoto) =>
  `${source(photo.id, "small")} 600w, ${source(photo.id, "large")} ${photo.width}w`;
