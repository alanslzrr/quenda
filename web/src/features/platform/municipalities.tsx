import { useState } from "react";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Reason } from "../municipal/shared";
import {
  AccountField,
  InvitationDeadline,
  MunicipalityField,
  Receipt,
} from "./fields";
import { invitationDates } from "./model";
import { PlatformForm } from "./shared";

type Result = { tenantId: string; invitationId: string };
export function NewMunicipality() {
  const { t, locale } = usePreferences();
  const [result, setResult] = useState<Result>();
  if (result)
    return (
      <Receipt
        result={result}
        message={t(
          "Municipio registrado. Invitación pendiente de aceptación.",
          "Municipio rexistrado. Invitación pendente de aceptación.",
        )}
      />
    );
  return (
    <>
      <h2>{t("Incorporar municipio", "Incorporar municipio")}</h2>
      <p>
        {t(
          "El alta crea el municipio y su primera invitación administrativa de forma conjunta. No concede acceso municipal al operador.",
          "A alta crea o municipio e a súa primeira invitación administrativa de forma conxunta. Non concede acceso municipal ao operador.",
        )}
      </p>
      <PlatformForm<Result>
        path="/api/municipalities"
        label={t("Registrar municipio", "Rexistrar municipio")}
        body={(d) => {
          const timezone = textField(d, "timezone").trim();
          try {
            if (/^[+-]/.test(timezone)) throw new Error();
            new Intl.DateTimeFormat("es", { timeZone: timezone });
          } catch {
            throw new ApiError(
              400,
              "INVALID_INPUT",
              t(
                "Indica una zona horaria IANA válida.",
                "Indica unha zona horaria IANA válida.",
              ),
            );
          }
          return {
            name: textField(d, "name").trim(),
            timezone,
            administratorId: textField(d, "accountId").trim(),
            invitationExpiresAt: invitationDates(d, locale).expiresAt,
          };
        }}
        onResult={setResult}
      >
        <Input
          name="name"
          label={t("Nombre del municipio", "Nome do municipio")}
          required
          maxLength={200}
        />
        <Input
          name="timezone"
          label={t(
            "Zona horaria del municipio (IANA)",
            "Zona horaria do municipio (IANA)",
          )}
          required
          maxLength={100}
          placeholder="Europe/Madrid"
        />
        <AccountField />
        <InvitationDeadline />
        <Checkbox
          required
          label={t(
            "Confirmo el municipio y su primer destinatario administrativo",
            "Confirmo o municipio e o seu primeiro destinatario administrativo",
          )}
        />
      </PlatformForm>
    </>
  );
}
export function MunicipalContinuity({
  recovery = false,
}: {
  recovery?: boolean;
}) {
  const { t, locale } = usePreferences();
  const [result, setResult] = useState<Result>();
  // No global municipal administration query exists. The operator supplies the exact scope.
  const [tenant, setTenant] = useState("");
  if (result)
    return (
      <Receipt
        result={result}
        message={t(
          "Invitación registrada. El destinatario debe aceptarla.",
          "Invitación rexistrada. O destinatario debe aceptala.",
        )}
      />
    );
  return (
    <>
      <h2>
        {recovery
          ? t(
              "Recuperar responsable municipal",
              "Recuperar responsable municipal",
            )
          : t("Sustituir invitación inicial", "Substituír invitación inicial")}
      </h2>
      <p>
        {recovery
          ? t(
              "Solo para municipios ya inicializados sin administradores habilitados. Verifica la autoridad por el procedimiento administrativo y registra su referencia. No se restauran permisos antiguos.",
              "Só para municipios xa inicializados sen administradores habilitados. Verifica a autoridade polo procedemento administrativo e rexistra a súa referencia. Non se restauran permisos antigos.",
            )
          : t(
              "Solo antes de la primera aceptación administrativa. Invalida las invitaciones iniciales pendientes; no retira permisos ya aceptados.",
              "Só antes da primeira aceptación administrativa. Invalida as invitacións iniciais pendentes; non retira permisos xa aceptados.",
            )}
      </p>
      <PlatformForm<Result>
        path={`/api/municipalities/${encodeURIComponent(tenant.trim())}/${recovery ? "administrator-recovery-invitations" : "initial-administrator-invitation/replace"}`}
        label={
          recovery
            ? t("Invitar a un sustituto", "Invitar a un substituto")
            : t("Sustituir invitación", "Substituír invitación")
        }
        body={(d) => ({
          accountId: textField(d, "accountId").trim(),
          ...invitationDates(d, locale),
          reason: textField(d, "reason").trim(),
          ...(recovery
            ? {
                verificationReference: textField(
                  d,
                  "verificationReference",
                ).trim(),
              }
            : {}),
        })}
        onResult={setResult}
      >
        <MunicipalityField value={tenant} onChange={setTenant} />
        <AccountField />
        <InvitationDeadline />
        <Reason />
        {recovery && (
          <Input
            label={t(
              "Referencia de verificación de autoridad",
              "Referencia de verificación de autoridade",
            )}
            name="verificationReference"
            required
            maxLength={500}
          />
        )}
        <Checkbox
          required
          label={t(
            "Confirmo el ámbito y la intervención autorizada",
            "Confirmo o ámbito e a intervención autorizada",
          )}
        />
      </PlatformForm>
    </>
  );
}
