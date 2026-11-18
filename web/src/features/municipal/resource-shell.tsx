import {
  CalendarCheck2,
  CalendarDays,
  CalendarPlus,
  ChartNoAxesCombined,
  ClipboardList,
  Download,
  FileCheck,
  Handshake,
  Landmark,
  Palette,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  TicketCheck,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { MunicipalLogo, useBranding } from "../../app/branding";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { SettingsMenu } from "../../app/settings-menu";
import { SidebarRail } from "../../ui/blocks/sidebar-rail/sidebar-rail";
import { MfaNotice } from "../account/mfa-dialog";
import { useBookingEntry } from "../catalog/journey";
import { allowed, canEnter } from "../reporting/model";
import { activeSection } from "./active-section";
import { type MunicipalContext, municipalPath } from "./shared";

export function ResourceShell({
  municipality: m,
  children,
}: {
  municipality: MunicipalContext;
  children: ReactNode;
}) {
  const { t } = usePreferences();
  const branding = useBranding(m.id).data;
  const { account } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const base = municipalPath(m.id);
  const entry = useBookingEntry();
  const has = (...ops: string[]) =>
    m.administrator || m.permissions.some((p) => ops.includes(p.operation));
  const item = (path: string, label: string, icon: typeof Landmark) => ({
    id: `${base}${path}`,
    label,
    icon,
  });
  const sections = [
    {
      id: "operations",
      heading: t("Gestión municipal", "Xestión municipal"),
      items: [
        ...(has("CATALOG_CREATE", "CATALOG_MANAGE")
          ? [
              item(
                "",
                t("Instalaciones y unidades", "Instalacións e unidades"),
                Landmark,
              ),
            ]
          : []),
        ...(has("RESERVATION_READ", "RESERVATION_MANAGE", "UNIT_BLOCK")
          ? [item("/agenda", t("Agenda diaria", "Axenda diaria"), CalendarDays)]
          : []),
        ...(canEnter(m)
          ? [
              item(
                "/uso-de-los-espacios",
                t("Uso de los espacios", "Uso dos espazos"),
                ChartNoAxesCombined,
              ),
            ]
          : []),
        ...(canEnter(m, true)
          ? [
              item(
                "/exportaciones",
                t("Exportar reservas", "Exportar reservas"),
                Download,
              ),
            ]
          : []),
      ],
    },
    {
      id: "administration",
      heading: t("Administración", "Administración"),
      items: [
        ...(m.administrator
          ? [
              item(
                "/personal",
                t("Personal y permisos", "Persoal e permisos"),
                Users,
              ),
              item("/convenios", "Convenios", Handshake),
              item(
                "/textos-legales",
                t("Textos legales", "Textos legais"),
                Scale,
              ),
              item(
                "/acreditaciones",
                t("Acreditaciones de uso", "Acreditacións de uso"),
                TicketCheck,
              ),
            ]
          : []),
        ...(allowed(m, "REPORT_READ", null)
          ? [
              item(
                "/informes",
                t("Informes conjuntos", "Informes conxuntos"),
                ClipboardList,
              ),
            ]
          : []),
        ...(m.administrator
          ? [
              item(
                "/informes/revision",
                t("Revisión de privacidad", "Revisión de privacidade"),
                FileCheck,
              ),
            ]
          : []),
        ...(m.permissions.some(
          (p) =>
            p.unitId === null &&
            ["PRIVACY_READ", "PRIVACY_EXECUTE"].includes(p.operation),
        )
          ? [
              item(
                "/privacidad",
                t("Conservación y derechos", "Conservación e dereitos"),
                ShieldCheck,
              ),
            ]
          : []),
      ],
    },
    {
      id: "configuration",
      heading: t("Configuración", "Configuración"),
      items: m.administrator
        ? [
            item(
              "/condiciones",
              t("Condiciones de reserva", "Condicións de reserva"),
              SlidersHorizontal,
            ),
            item("/apariencia", t("Apariencia", "Aparencia"), Palette),
          ]
        : [],
    },
    {
      id: "personal",
      heading: t("Uso personal", "Uso persoal"),
      items: [
        { id: entry, label: t("Reservar", "Reservar"), icon: CalendarPlus },
        {
          id: "/reservas",
          label: t("Mis reservas", "As miñas reservas"),
          icon: CalendarCheck2,
        },
      ],
    },
  ].filter((s) => s.items.length);
  return (
    <SidebarRail
      sections={sections}
      active={activeSection(
        sections.flatMap((section) => section.items).map((item) => item.id),
        pathname,
        base,
      )}
      onSelect={navigate}
      municipality={m.name}
      mark={
        branding?.logos.light ? (
          <MunicipalLogo tenantId={m.id} branding={branding} size="sm" />
        ) : undefined
      }
      email={account?.email ?? ""}
      labels={{
        navigation: t("Gestión municipal", "Xestión municipal"),
        expand: t("Expandir navegación", "Expandir navegación"),
        collapse: t("Contraer navegación", "Contraer navegación"),
        close: t("Cerrar navegación", "Pechar navegación"),
        municipalities: t("Cambiar municipio", "Cambiar municipio"),
        account: t("Mi cuenta", "A miña conta"),
      }}
      toolbar={
        <>
          <span>{m.name}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <SettingsMenu />
          </div>
        </>
      }
    >
      <MfaNotice />
      {children}
    </SidebarRail>
  );
}
