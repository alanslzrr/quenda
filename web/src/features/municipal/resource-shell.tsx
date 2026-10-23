import {
  CalendarDays,
  ChartNoAxesCombined,
  ClipboardList,
  Download,
  FileCheck,
  Handshake,
  Landmark,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  TicketCheck,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { SettingsMenu } from "../../app/settings-menu";
import { SidebarRail } from "../../ui/blocks/sidebar-rail/sidebar-rail";
import { MfaDialog } from "../account/mfa-dialog";
import { allowed, canEnter } from "../reporting/model";
import { type MunicipalContext, municipalPath } from "./shared";

export function ResourceShell({
  municipality: m,
  children,
}: {
  municipality: MunicipalContext;
  children: ReactNode;
}) {
  const { t } = usePreferences();
  const { account } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const base = municipalPath(m.id);
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
                "/indicadores",
                t("Indicadores", "Indicadores"),
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
                "/acreditaciones",
                t("Acreditaciones", "Acreditacións"),
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
                t("Revisar informes", "Revisar informes"),
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
  ].filter((s) => s.items.length);
  return (
    <SidebarRail
      sections={sections}
      active={
        sections
          .flatMap((section) => section.items)
          .map((item) => item.id)
          .filter((id) => pathname === id || pathname.startsWith(`${id}/`))
          .sort((a, b) => b.length - a.length)[0] ?? base
      }
      onSelect={navigate}
      municipality={m.name}
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
          <Link to={base}>{t("Volver al catálogo", "Volver ao catálogo")}</Link>
          <div style={{ display: "flex", gap: 8 }}>
            <MfaDialog />
            <SettingsMenu />
          </div>
        </>
      }
    >
      {children}
    </SidebarRail>
  );
}
