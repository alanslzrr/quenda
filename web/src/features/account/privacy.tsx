import { Link } from "react-router";
import { ActionForm, textField } from "../../app/action";
import { api } from "../../app/api";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { PageTitle, SecretField } from "./shared";

export function AccountPrivacy() {
  const { t, locale } = usePreferences();
  return (
    <>
      <PageTitle
        title={t("Privacidad y baja de cuenta", "Privacidade e baixa de conta")}
      />
      <section className={styles.section}>
        <h2>{t("Descargar tus datos", "Descargar os teus datos")}</h2>
        <p>
          {t(
            "La descarga contiene tus datos accesibles en esta instancia e identifica sus exclusiones. No equivale a una respuesta completa al derecho de acceso. Puedes tramitar solicitudes adicionales ante la administración responsable.",
            "A descarga contén os teus datos accesibles nesta instancia e identifica as súas exclusións. Non equivale a unha resposta completa ao dereito de acceso. Podes tramitar solicitudes adicionais ante a administración responsable.",
          )}
        </p>
        <ActionForm
          label={t("Descargar datos personales", "Descargar datos persoais")}
          submit={async () => {
            const result = await api<unknown>(
              "/api/me/personal-data",
              {},
              locale,
            );
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(result, null, 2)], {
                type: "application/json",
              }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "quenda-personal-data.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        />
      </section>
      <section className={styles.section}>
        <h2>{t("Dar de baja la cuenta", "Dar de baixa a conta")}</h2>
        <p>
          {t(
            "La baja afecta a toda la instancia. Cierra tus sesiones y retira tus permisos, pero no elimina automáticamente las reservas ni las evidencias conservadas.",
            "A baixa afecta a toda a instancia. Pecha as túas sesións e retira os teus permisos, pero non elimina automaticamente as reservas nin as evidencias conservadas.",
          )}
        </p>
        <p>
          {t(
            "No puedes darte de baja con reservas confirmadas futuras o en curso, ni sin resolver el relevo si eres el último responsable.",
            "Non podes darte de baixa con reservas confirmadas futuras ou en curso, nin sen resolver a substitución se es o último responsable.",
          )}
        </p>
        <p>
          <Link to="/perfil/seguridad">
            {t(
              "Si tienes MFA, verifícalo antes de continuar",
              "Se tes MFA, verifícao antes de continuar",
            )}
          </Link>
        </p>
        <ActionForm
          label={t("Confirmar baja de cuenta", "Confirmar baixa de conta")}
          danger
          submit={async (data) => {
            await api(
              "/api/me/deactivation",
              {
                method: "POST",
                body: JSON.stringify({
                  confirm: true,
                  password: textField(data, "password"),
                }),
              },
              locale,
            );
            window.location.replace("/acceso?notice=deactivated");
          }}
        >
          <SecretField
            label={t("Contraseña actual", "Contrasinal actual")}
            name="password"
          />
          <Checkbox
            required
            name="confirm"
            label={t(
              "Quiero desactivar mi cuenta global",
              "Quero desactivar a miña conta global",
            )}
          />
        </ActionForm>
      </section>
    </>
  );
}
