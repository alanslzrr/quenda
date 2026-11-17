import { useParams } from "react-router";
import { usePreferences } from "../../app/preferences-provider";
import { Badge } from "../../ui/badge/badge";
import { SectionNav } from "../../ui/section-nav/section-nav";
import { ManagementPage } from "../municipal/page";
import { Denied } from "../municipal/shared";
import { PlatformShell } from "../platform/shell";
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
import { Policies, RetentionOverview } from "./queries";
import { SharedRetention } from "./shared-retention";
export function MunicipalPrivacy() {
  return (
    <MunicipalPrivacyScope>
      <Workspace />
    </MunicipalPrivacyScope>
  );
}
export function GlobalPrivacy() {
  return (
    <PlatformShell>
      <GlobalPrivacyScope>
        <Workspace />
      </GlobalPrivacyScope>
    </PlatformShell>
  );
}
function Workspace() {
  const s = usePrivacyScope();
  const { section } = useParams();
  const { t } = usePreferences();
  const current = section ?? (s.read ? "politicas" : "aprobar");
  const pages = [
    ...(!s.global
      ? [
          {
            id: "compartida",
            label: t("Conservación compartida", "Conservación compartida"),
            read: true,
            component: <SharedRetention />,
          },
        ]
      : []),
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
    <ManagementPage
      title={t("Conservación y derechos", "Conservación e dereitos")}
      status={<Badge size="sm">{s.name}</Badge>}
      description={t(
        "Consulta y ejecución requieren permisos independientes y una verificación en dos pasos reciente. Las solicitudes de derechos se tramitan por los canales administrativos existentes.",
        "Consulta e execución requiren permisos independentes e unha verificación en dous pasos recente. As solicitudes de dereitos tramítanse polas canles administrativas existentes.",
      )}
    >
      <SectionNav
        label={t("Gestión de privacidad", "Xestión de privacidade")}
        groups={[
          { label: t("Consultar", "Consultar"), read: true, allowed: s.read },
          { label: t("Actuar", "Actuar"), read: false, allowed: s.execute },
        ].map((group) => ({
          label: group.label,
          items: group.allowed
            ? pages
                .filter((p) => p.read === group.read)
                .map((p) => ({
                  to: `${s.view}/${p.id}`,
                  label: p.label,
                  current: p.id === current,
                }))
            : [],
        }))}
      />
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
    </ManagementPage>
  );
}
