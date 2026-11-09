import { useState } from "react";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { Textarea } from "../../ui/textarea/textarea";
import {
  type FacilityProfile,
  kindName,
  type UnitKind,
  type UnitProfile,
  unitKinds,
} from "../catalog/profile";
import styles from "./municipal.module.css";
import { MunicipalForm } from "./shared";

const unset = "none";
interface SavedProfile {
  profileVersion: number;
}

function optional(value: string) {
  const text = value.trim();
  return text === "" ? undefined : text;
}
function localizedBody(gl: string, es: string) {
  const value = { gl: optional(gl), es: optional(es) };
  return value.gl || value.es ? value : undefined;
}

/** Replaces the whole facility profile; leaving a field empty removes it from the public page. */
export function FacilityProfileEditor({
  path,
  profile,
  version,
}: {
  path: string;
  profile: FacilityProfile;
  version: number;
}) {
  const { t } = usePreferences();
  // The version the person started from; a later background refresh must not silently replace it.
  const [known, setKnown] = useState(version);
  return (
    <section className={styles.section} aria-labelledby="facility-profile">
      <h2 id="facility-profile">{t("Ficha pública", "Ficha pública")}</h2>
      <p>
        {t(
          "Es lo que verá la ciudadanía al elegir la instalación. Todos los campos son opcionales. No incluyas datos personales: usa un teléfono y un correo institucionales.",
          "Isto é o que verá a cidadanía ao escoller a instalación. Todos os campos son opcionais. Non inclúas datos persoais: usa un teléfono e un correo institucionais.",
        )}
      </p>
      <MunicipalForm
        path={`${path}/profile`}
        method="PUT"
        label={t("Guardar ficha", "Gardar ficha")}
        onSaved={(result) => setKnown((result as SavedProfile).profileVersion)}
        body={(d) => {
          const latitude = optional(textField(d, "latitude"));
          const longitude = optional(textField(d, "longitude"));
          if ((latitude === undefined) !== (longitude === undefined))
            throw new ApiError(
              400,
              "INVALID_INPUT",
              t(
                "Indica latitud y longitud, o ninguna de las dos.",
                "Indica latitude e lonxitude, ou ningunha das dúas.",
              ),
            );
          const phone = optional(textField(d, "phone"));
          const email = optional(textField(d, "email"));
          return {
            expectedVersion: known,
            address: optional(textField(d, "address")),
            postalCode: optional(textField(d, "postalCode")),
            location:
              latitude !== undefined && longitude !== undefined
                ? {
                    latitude: Number(latitude.replace(",", ".")),
                    longitude: Number(longitude.replace(",", ".")),
                  }
                : undefined,
            description: localizedBody(
              textField(d, "descriptionGl"),
              textField(d, "descriptionEs"),
            ),
            accessibility: localizedBody(
              textField(d, "accessibilityGl"),
              textField(d, "accessibilityEs"),
            ),
            contact: phone || email ? { phone, email } : undefined,
          };
        }}
      >
        <Input
          label={t("Dirección", "Enderezo")}
          name="address"
          maxLength={300}
          autoComplete="off"
          defaultValue={profile.address ?? ""}
        />
        <Input
          label={t("Código postal", "Código postal")}
          name="postalCode"
          inputMode="numeric"
          pattern="[0-9]{5}"
          maxLength={5}
          defaultValue={profile.postalCode ?? ""}
        />
        <Input
          label={t("Latitud", "Latitude")}
          name="latitude"
          inputMode="decimal"
          description={t(
            "Opcional. Permite ofrecer un enlace «Cómo llegar».",
            "Opcional. Permite ofrecer unha ligazón «Como chegar».",
          )}
          defaultValue={profile.location?.latitude ?? ""}
        />
        <Input
          label={t("Longitud", "Lonxitude")}
          name="longitude"
          inputMode="decimal"
          defaultValue={profile.location?.longitude ?? ""}
        />
        <Textarea
          label={t("Descripción en gallego", "Descrición en galego")}
          name="descriptionGl"
          maxLength={1000}
          defaultValue={profile.description?.gl ?? ""}
        />
        <Textarea
          label={t("Descripción en castellano", "Descrición en castelán")}
          name="descriptionEs"
          maxLength={1000}
          defaultValue={profile.description?.es ?? ""}
        />
        <Textarea
          label={t("Accesibilidad en gallego", "Accesibilidade en galego")}
          name="accessibilityGl"
          maxLength={1000}
          defaultValue={profile.accessibility?.gl ?? ""}
        />
        <Textarea
          label={t("Accesibilidad en castellano", "Accesibilidade en castelán")}
          name="accessibilityEs"
          maxLength={1000}
          defaultValue={profile.accessibility?.es ?? ""}
        />
        <Input
          label={t("Teléfono de contacto", "Teléfono de contacto")}
          name="phone"
          type="tel"
          maxLength={30}
          defaultValue={profile.contact?.phone ?? ""}
        />
        <Input
          label={t("Correo de contacto", "Correo de contacto")}
          name="email"
          type="email"
          maxLength={254}
          defaultValue={profile.contact?.email ?? ""}
        />
      </MunicipalForm>
    </section>
  );
}

export function UnitProfileEditor({
  path,
  profile,
  version,
}: {
  path: string;
  profile: UnitProfile;
  version: number;
}) {
  const { locale, t } = usePreferences();
  const [known, setKnown] = useState(version);
  const [kind, setKind] = useState<string>(profile.kind ?? unset);
  const [setting, setSetting] = useState<string>(
    profile.indoor === undefined
      ? unset
      : profile.indoor
        ? "indoor"
        : "outdoor",
  );
  return (
    <section className={styles.section} aria-labelledby="unit-profile">
      <h2 id="unit-profile">{t("Ficha pública", "Ficha pública")}</h2>
      <p>
        {t(
          "Ayuda a distinguir este espacio de los demás de la instalación. Todos los campos son opcionales.",
          "Axuda a distinguir este espazo dos demais da instalación. Todos os campos son opcionais.",
        )}
      </p>
      <MunicipalForm
        path={`${path}/profile`}
        method="PUT"
        label={t("Guardar ficha", "Gardar ficha")}
        onSaved={(result) => setKnown((result as SavedProfile).profileVersion)}
        body={(d) => {
          const capacity = optional(textField(d, "capacity"));
          return {
            expectedVersion: known,
            kind: kind === unset ? undefined : (kind as UnitKind),
            indoor: setting === unset ? undefined : setting === "indoor",
            capacity: capacity === undefined ? undefined : Number(capacity),
            description: localizedBody(
              textField(d, "descriptionGl"),
              textField(d, "descriptionEs"),
            ),
          };
        }}
      >
        <Select
          label={t("Tipo de espacio", "Tipo de espazo")}
          value={kind}
          onValueChange={setKind}
          options={[
            { value: unset, label: t("Sin indicar", "Sen indicar") },
            ...unitKinds.map((value) => ({
              value,
              label: kindName(value, locale),
            })),
          ]}
        />
        <Select
          label={t("Ubicación", "Localización")}
          value={setting}
          onValueChange={setSetting}
          options={[
            { value: unset, label: t("Sin indicar", "Sen indicar") },
            { value: "indoor", label: t("Cubierto", "Cuberto") },
            { value: "outdoor", label: t("Al aire libre", "Ao aire libre") },
          ]}
        />
        <Input
          label={t("Aforo máximo (personas)", "Aforo máximo (persoas)")}
          name="capacity"
          type="number"
          inputMode="numeric"
          min={1}
          max={10000}
          step={1}
          defaultValue={profile.capacity ?? ""}
        />
        <Textarea
          label={t("Descripción en gallego", "Descrición en galego")}
          name="descriptionGl"
          maxLength={1000}
          defaultValue={profile.description?.gl ?? ""}
        />
        <Textarea
          label={t("Descripción en castellano", "Descrición en castelán")}
          name="descriptionEs"
          maxLength={1000}
          defaultValue={profile.description?.es ?? ""}
        />
      </MunicipalForm>
    </section>
  );
}
