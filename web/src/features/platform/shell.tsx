import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CalendarCheck2,
  CalendarPlus,
  KeyRound,
  LifeBuoy,
  Mail,
  Scale,
  ShieldCheck,
  UserCog,
  UserPlus,
  UserX,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, type Navigation } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { SettingsMenu } from "../../app/settings-menu";
import { SidebarRail } from "../../ui/blocks/sidebar-rail/sidebar-rail";
import { MfaNotice } from "../account/mfa-dialog";
import { useBookingEntry } from "../catalog/journey";
import { platformView } from "./shared";

const globalPrivacyView = "/plataforma/privacidad";

/**
 * The workspace for platform operators and global privacy holders. It shares the municipal management frame, so a
 * person moving between both finds the same navigation, and it shows only the destinations their permissions open.
 */
export function PlatformShell({ children }: { children: ReactNode }) {
  const { t, locale } = usePreferences();
  const { account } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const entry = useBookingEntry();
  // The same read as the operator guard, so the menu costs no request of its own.
  const query = useQuery({
    queryKey: ["private", account?.accountId, "platform-context", locale],
    queryFn: ({ signal }) =>
      api<Navigation>("/api/me/navigation", { signal }, locale),
    retry: false,
  });
  const platform = query.data?.platform;
  const operator = !!platform?.operator;
  const privacy = !!platform?.permissions.some((p) =>
    ["PRIVACY_READ", "PRIVACY_EXECUTE"].includes(p),
  );
  const item = (path: string, label: string, icon: typeof UserCog) => ({
    id: `${platformView}/${path}`,
    label,
    icon,
  });
  const sections = [
    {
      id: "access",
      heading: t("Acceso a la plataforma", "Acceso á plataforma"),
      items: operator
        ? [
            item("operadores", t("Operadores", "Operadores"), UserCog),
            item(
              "invitaciones",
              t("Invitaciones de operadores", "Invitacións de operadores"),
              Mail,
            ),
            item(
              "privacidad",
              t("Privacidad global", "Privacidade global"),
              KeyRound,
            ),
          ]
        : [],
    },
    {
      id: "municipalities",
      heading: t("Municipios", "Municipios"),
      items: operator
        ? [
            item(
              "nuevo-municipio",
              t("Incorporar municipio", "Incorporar municipio"),
              Building2,
            ),
            item(
              "invitacion-inicial",
              t("Invitación inicial", "Invitación inicial"),
              UserPlus,
            ),
            item(
              "recuperar-responsable",
              t("Recuperar responsable", "Recuperar responsable"),
              LifeBuoy,
            ),
          ]
        : [],
    },
    {
      id: "instance",
      heading: t("Instancia", "Instancia"),
      items: [
        ...(operator
          ? [
              item(
                "textos-legales",
                t("Textos legales", "Textos legais"),
                Scale,
              ),
            ]
          : []),
        ...(privacy
          ? [
              {
                id: globalPrivacyView,
                label: t("Conservación y derechos", "Conservación e dereitos"),
                icon: ShieldCheck,
              },
            ]
          : []),
        ...(operator
          ? [
              item(
                "suspender",
                t("Suspender identidad", "Suspender identidade"),
                UserX,
              ),
            ]
          : []),
      ],
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
  const ids = sections.flatMap((s) => s.items.map((i) => i.id));
  // Forms opened from a list (invite, revoke) belong to that list in the menu.
  const owner: Record<string, string> = {
    "invitar-operador": "operadores",
    "retirar-operador": "operadores",
    "retirar-invitacion": "invitaciones",
    "invitar-privacidad": "privacidad",
    "retirar-privacidad": "privacidad",
  };
  const section = pathname.startsWith(`${platformView}/`)
    ? pathname.slice(platformView.length + 1).split("/")[0]
    : "";
  const current =
    pathname === "/plataforma"
      ? `${platformView}/operadores`
      : owner[section]
        ? `${platformView}/${owner[section]}`
        : pathname;
  const title = t("Plataforma", "Plataforma");
  return (
    <SidebarRail
      sections={sections}
      active={
        ids
          .filter((id) => current === id || current.startsWith(`${id}/`))
          .sort((a, b) => b.length - a.length)[0] ?? ""
      }
      onSelect={navigate}
      municipality={title}
      email={account?.email ?? ""}
      labels={{
        navigation: t("Gestión de plataforma", "Xestión de plataforma"),
        expand: t("Expandir navegación", "Expandir navegación"),
        collapse: t("Contraer navegación", "Contraer navegación"),
        close: t("Cerrar navegación", "Pechar navegación"),
        municipalities: t("Volver a Gestión", "Volver a Xestión"),
        account: t("Mi cuenta", "A miña conta"),
      }}
      toolbar={
        <>
          <span>{title}</span>
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
