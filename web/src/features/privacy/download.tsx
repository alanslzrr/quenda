import { useState } from "react";
import { textField } from "../../app/action";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { usePrivacyScope } from "./context";
import { Authorization } from "./fields";
import { PrivacyForm } from "./form";
import type { PersonalData } from "./model";
export function PersonalDownload() {
  const s = usePrivacyScope();
  const { t } = usePreferences();
  const [id, setId] = useState("");
  const [done, setDone] = useState(false);
  return (
    <>
      <h2>
        {t("Copia administrativa de datos", "Copia administrativa de datos")}
      </h2>
      <p>
        {s.global
          ? t(
              "Incluye identidad y seguridad globales, no actividad municipal.",
              "Inclúe identidade e seguridade globais, non actividade municipal.",
            )
          : t(
              "Incluye únicamente los datos del municipio indicado, también para cuentas inactivas.",
              "Inclúe unicamente os datos do municipio indicado, tamén para contas inactivas.",
            )}
      </p>
      <p>
        {t(
          "La copia es parcial: no sustituye la respuesta completa al derecho de acceso. Excluye secretos, archivos bloqueados e información pendiente de revisión. No se guarda su contenido en la aplicación.",
          "A copia é parcial: non substitúe a resposta completa ao dereito de acceso. Exclúe segredos, arquivos bloqueados e información pendente de revisión. Non se garda o seu contido na aplicación.",
        )}
      </p>
      {done ? (
        <p role="status">
          {t(
            "Copia parcial preparada para descargar. Revisa las exclusiones antes de entregarla.",
            "Copia parcial preparada para descargar. Revisa as exclusións antes de entregala.",
          )}
        </p>
      ) : (
        <PrivacyForm<PersonalData>
          path={`${s.base}/accounts/${encodeURIComponent(id)}/personal-data`}
          label={t("Preparar copia", "Preparar copia")}
          body={(d) => ({
            authorizationReference: textField(
              d,
              "authorizationReference",
            ).trim(),
            reason: textField(d, "reason").trim(),
          })}
          onResult={(r) => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(r, null, 2)], {
                type: "application/json",
              }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "quenda-personal-data.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setDone(true);
          }}
        >
          <Input
            required
            maxLength={128}
            value={id}
            onChange={(e) => setId(e.target.value)}
            label={t("Identificador de la cuenta", "Identificador da conta")}
          />
          <Authorization />
          <Checkbox
            required
            label={t(
              "Confirmo la preparación autorizada de esta copia parcial",
              "Confirmo a preparación autorizada desta copia parcial",
            )}
          />
        </PrivacyForm>
      )}
    </>
  );
}
