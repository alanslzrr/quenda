import { useParams, useSearchParams } from "react-router";
import { ActionLink as Link } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import styles from "../privacy/privacy.module.css";
import { Invite, Revoke, SuspendAccount } from "./authority";
import { Operators, PlatformInvitations } from "./lists";
import { MunicipalContinuity, NewMunicipality } from "./municipalities";
import { OperatorGuard, platformView } from "./shared";
export function Platform() {
  return (
    <OperatorGuard>
      <Workspace />
    </OperatorGuard>
  );
}
function Workspace() {
  const { section = "operadores" } = useParams();
  const [search] = useSearchParams();
  const { account } = useSession();
  const { t } = usePreferences();
  const pages = [
    {
      id: "operadores",
      label: t("Operadores", "Operadores"),
      component: <Operators />,
    },
    {
      id: "invitaciones",
      label: t("Invitaciones de operadores", "Invitacións de operadores"),
      component: <PlatformInvitations />,
    },
    {
      id: "privacidad",
      label: t(
        "Permisos de privacidad global",
        "Permisos de privacidade global",
      ),
      component: <PlatformInvitations privacy />,
    },
    {
      id: "nuevo-municipio",
      label: t("Incorporar municipio", "Incorporar municipio"),
      component: <NewMunicipality />,
    },
    {
      id: "invitacion-inicial",
      label: t("Sustituir invitación inicial", "Substituír invitación inicial"),
      component: <MunicipalContinuity />,
    },
    {
      id: "recuperar-responsable",
      label: t(
        "Recuperar responsable municipal",
        "Recuperar responsable municipal",
      ),
      component: <MunicipalContinuity recovery />,
    },
    {
      id: "suspender",
      label: t("Suspender identidad global", "Suspender identidade global"),
      component: <SuspendAccount />,
    },
  ];
  const forms: Record<string, React.ReactNode> = {
    "invitar-operador": <Invite />,
    "invitar-privacidad": <Invite privacy />,
    "retirar-operador": <Revoke kind="operator" />,
    "retirar-invitacion": <Revoke kind="invitation" />,
    "retirar-privacidad": <Revoke kind="privacy" />,
  };
  return (
    <div className={styles.surface}>
      <Link to="/administracion">{t("Administración", "Administración")}</Link>
      <h1>
        {t("Administración de plataforma", "Administración de plataforma")}
      </h1>
      <p>
        {t(
          "Estas operaciones requieren permiso de operador y MFA verificado en los últimos cinco minutos. No conceden acceso general a la actividad municipal.",
          "Estas operacións requiren permiso de operador e MFA verificado nos últimos cinco minutos. Non conceden acceso xeral á actividade municipal.",
        )}
      </p>
      <nav
        className={styles.nav}
        aria-label={t("Gestión de plataforma", "Xestión de plataforma")}
      >
        {pages.map((p) => (
          <Link
            key={p.id}
            to={`${platformView}/${p.id}`}
            aria-current={p.id === section ? "page" : undefined}
          >
            {p.label}
          </Link>
        ))}
      </nav>
      <div key={`${account?.accountId}:${section}:${search.get("id") ?? ""}`}>
        {pages.find((p) => p.id === section)?.component ?? forms[section] ?? (
          <p>{t("Sección no encontrada.", "Sección non atopada.")}</p>
        )}
      </div>
    </div>
  );
}
