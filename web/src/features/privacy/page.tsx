import { useParams } from "react-router";
import { ActionLink as Link } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { Denied } from "../municipal/shared";
import {
  GlobalPrivacyScope,
  MunicipalPrivacyScope,
  usePrivacyScope,
} from "./context";
import { PersonalDownload } from "./download";
import {
  ApprovePolicy,
  CreateHold,
  IndividualAction,
  ReleaseHold,
  RevokePolicy,
} from "./operations";
import styles from "./privacy.module.css";
import { Policies, RetentionOverview } from "./queries";
export function MunicipalPrivacy() {
  return (
    <MunicipalPrivacyScope>
      <Workspace />
    </MunicipalPrivacyScope>
  );
}
export function GlobalPrivacy() {
  return (
    <GlobalPrivacyScope>
      <Workspace />
    </GlobalPrivacyScope>
  );
}
function Workspace() {
  const s = usePrivacyScope();
  const { section } = useParams();
  const { t } = usePreferences();
  const current = section ?? (s.read ? "politicas" : "aprobar");
  const pages = [
    {
      id: "politicas",
      label: t("Políticas", "Políticas"),
      read: true,
      component: <Policies />,
    },
    {
      id: "excepciones",
      label: t("Excepciones y conflictos", "Excepcións e conflitos"),
      read: true,
      component: <RetentionOverview />,
    },
    {
      id: "descarga",
      label: t("Copia de datos", "Copia de datos"),
      read: true,
      component: <PersonalDownload />,
    },
    {
      id: "aprobar",
      label: t("Registrar política", "Rexistrar política"),
      read: false,
      component: <ApprovePolicy />,
    },
    {
      id: "retirar",
      label: t("Retirar política", "Retirar política"),
      read: false,
      component: <RevokePolicy />,
    },
    {
      id: "registrar-excepcion",
      label: t("Registrar excepción", "Rexistrar excepción"),
      read: false,
      component: <CreateHold />,
    },
    {
      id: "levantar",
      label: t("Levantar excepción", "Levantar excepción"),
      read: false,
      component: <ReleaseHold />,
    },
    {
      id: "actuacion",
      label: t("Actuación individual", "Actuación individual"),
      read: false,
      component: <IndividualAction />,
    },
  ];
  const page = pages.find((p) => p.id === current);
  return (
    <div className={styles.surface}>
      <h1>{t("Conservación y derechos", "Conservación e dereitos")}</h1>
      <p>
        <strong>{s.name}</strong>
      </p>
      <p>
        {t(
          "Consulta y ejecución requieren permisos independientes y MFA reciente. Las solicitudes de derechos se tramitan por los canales administrativos existentes.",
          "Consulta e execución requiren permisos independentes e MFA recente. As solicitudes de dereitos tramítanse polas canles administrativas existentes.",
        )}
      </p>
      <nav
        className={styles.nav}
        aria-label={t("Gestión de privacidad", "Xestión de privacidade")}
      >
        {pages
          .filter((p) => (p.read ? s.read : s.execute))
          .map((p) => (
            <Link
              key={p.id}
              aria-current={p.id === current ? "page" : undefined}
              to={`${s.view}/${p.id}`}
            >
              {p.label}
            </Link>
          ))}
      </nav>
      <div key={`${s.base}:${current}`}>
        {page ? (
          (page.read ? s.read : s.execute) ? (
            page.component
          ) : (
            <Denied />
          )
        ) : (
          <p>{t("Sección no encontrada.", "Sección non atopada.")}</p>
        )}
      </div>
    </div>
  );
}
