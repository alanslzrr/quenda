import { KeyRound, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { BackLink, LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { InstanceNotices } from "../legal/notice-editor";
import { ManagementPage } from "../municipal/page";
import { Invite, Revoke, SuspendAccount } from "./authority";
import { Operators, PlatformInvitations } from "./lists";
import { MunicipalContinuity, NewMunicipality } from "./municipalities";
import { OperatorGuard, platformView } from "./shared";
import { PlatformShell } from "./shell";

export function Platform() {
  return (
    <PlatformShell>
      <OperatorGuard>
        <Workspace />
      </OperatorGuard>
    </PlatformShell>
  );
}
type View = {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** The list a form was opened from, offered as the way back. */
  parent?: { id: string; label: string };
  component: ReactNode;
};
function Workspace() {
  const { section = "operadores" } = useParams();
  const [search] = useSearchParams();
  const { account } = useSession();
  const { t } = usePreferences();
  const operators = { id: "operadores", label: t("Operadores", "Operadores") };
  const invitations = {
    id: "invitaciones",
    label: t("Invitaciones de operadores", "Invitacións de operadores"),
  };
  const privacy = {
    id: "privacidad",
    label: t("Permisos de privacidad global", "Permisos de privacidade global"),
  };
  const invite = (
    <LinkButton variant="primary" to={`${platformView}/invitar-operador`}>
      <UserPlus size={16} aria-hidden="true" />
      {t("Invitar operador", "Invitar operador")}
    </LinkButton>
  );
  const revoke = t("Retirar autorización", "Retirar autorización");
  const views: Record<string, View> = {
    operadores: {
      title: operators.label,
      description: t(
        "Estas operaciones requieren permiso de operador y haber completado la verificación en dos pasos en los últimos cinco minutos. No conceden acceso general a la actividad municipal.",
        "Estas operacións requiren permiso de operador e ter completada a verificación en dous pasos nos últimos cinco minutos. Non conceden acceso xeral á actividade municipal.",
      ),
      actions: invite,
      component: (
        <>
          <p>
            {t(
              "El permiso es indefinido. Habilitado exige cuenta activa, correo verificado y verificación en dos pasos activada; no exige mantener una sesión abierta.",
              "O permiso é indefinido. Habilitado esixe conta activa, correo verificado e verificación en dous pasos activada; non esixe manter unha sesión aberta.",
            )}
          </p>
          <Operators />
        </>
      ),
    },
    invitaciones: {
      title: invitations.label,
      description: t(
        "Una invitación aceptada no acredita el permiso actual. Consulta Operadores para comprobarlo o retirarlo.",
        "Unha invitación aceptada non acredita o permiso actual. Consulta Operadores para comprobalo ou retiralo.",
      ),
      actions: invite,
      component: <PlatformInvitations />,
    },
    privacidad: {
      title: privacy.label,
      description: t(
        "Concesiones de consulta y ejecución sobre identidad y seguridad globales. No incluyen actividad municipal.",
        "Concesións de consulta e execución sobre identidade e seguridade globais. Non inclúen actividade municipal.",
      ),
      actions: (
        <LinkButton variant="primary" to={`${platformView}/invitar-privacidad`}>
          <KeyRound size={16} aria-hidden="true" />
          {t("Conceder privacidad global", "Conceder privacidade global")}
        </LinkButton>
      ),
      component: <PlatformInvitations privacy />,
    },
    "textos-legales": {
      title: t("Textos legales de la instancia", "Textos legais da instancia"),
      component: <InstanceNotices />,
    },
    "nuevo-municipio": {
      title: t("Incorporar municipio", "Incorporar municipio"),
      component: <NewMunicipality />,
    },
    "invitacion-inicial": {
      title: t("Sustituir invitación inicial", "Substituír invitación inicial"),
      component: <MunicipalContinuity />,
    },
    "recuperar-responsable": {
      title: t(
        "Recuperar responsable municipal",
        "Recuperar responsable municipal",
      ),
      component: <MunicipalContinuity recovery />,
    },
    suspender: {
      title: t("Suspender identidad global", "Suspender identidade global"),
      component: <SuspendAccount />,
    },
    "invitar-operador": {
      title: t("Invitar operador", "Invitar operador"),
      parent: operators,
      component: <Invite />,
    },
    "invitar-privacidad": {
      title: t("Conceder privacidad global", "Conceder privacidade global"),
      parent: privacy,
      component: <Invite privacy />,
    },
    "retirar-operador": {
      title: revoke,
      parent: operators,
      component: <Revoke kind="operator" />,
    },
    "retirar-invitacion": {
      title: revoke,
      parent: invitations,
      component: <Revoke kind="invitation" />,
    },
    "retirar-privacidad": {
      title: revoke,
      parent: privacy,
      component: <Revoke kind="privacy" />,
    },
  };
  const view = Object.hasOwn(views, section) ? views[section] : undefined;
  return (
    <ManagementPage
      title={view?.title ?? t("Sección no encontrada", "Sección non atopada")}
      description={view?.description}
      actions={view?.actions}
      breadcrumb={
        view?.parent && (
          <BackLink to={`${platformView}/${view.parent.id}`}>
            {view.parent.label}
          </BackLink>
        )
      }
    >
      <div key={`${account?.accountId}:${section}:${search.get("id") ?? ""}`}>
        {view?.component ?? (
          <LinkButton to={`${platformView}/operadores`}>
            {t("Ir a Operadores", "Ir a Operadores")}
          </LinkButton>
        )}
      </div>
    </ManagementPage>
  );
}
