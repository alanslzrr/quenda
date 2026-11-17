import { Check, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { DropdownMenu } from "../ui/dropdown-menu/dropdown-menu";
import { Failure } from "./feedback";
import { usePreferences } from "./preferences-provider";
import { useSession } from "./session";
import { useUnreadNotices } from "./unread-notices";

export function SettingsMenu() {
  const { account, signOut } = useSession();
  const [leaving, setLeaving] = useState(false);
  async function leave() {
    setError(undefined);
    setLeaving(true);
    try {
      await signOut();
      window.location.replace("/");
    } catch (error) {
      setError(error);
      setLeaving(false);
    }
  }
  const { locale, theme, save, pending, t } = usePreferences();
  const [error, setError] = useState<unknown>();
  const unread = useUnreadNotices();
  const unreadText =
    unread === 1
      ? t("1 aviso sin leer", "1 aviso sen ler")
      : t(`${unread} avisos sin leer`, `${unread} avisos sen ler`);
  const update = (value: Parameters<typeof save>[0]) => {
    setError(undefined);
    void save(value).catch(setError);
  };
  return (
    <div>
      <DropdownMenu
        label={t("Ajustes", "Axustes")}
        icon={<Settings size={16} />}
        indicator={unread > 0 ? unreadText : undefined}
        items={[
          ...(account
            ? [
                {
                  label: t("Mi cuenta", "A miña conta"),
                  to: "/perfil",
                },
                {
                  label: t("Mis reservas", "As miñas reservas"),
                  to: "/reservas",
                },
                {
                  label: t("Avisos", "Avisos"),
                  to: "/avisos",
                  ...(unread > 0
                    ? {
                        badge: {
                          text: unread > 99 ? "99+" : String(unread),
                          label: unreadText,
                        },
                      }
                    : {}),
                },
              ]
            : []),
          {
            label: "Galego",
            separatorBefore: !!account,
            icon: locale === "gl" ? <Check size={16} /> : undefined,
            current: locale === "gl",
            disabled: pending,
            onSelect: () => locale !== "gl" && update({ locale: "gl" }),
          },
          {
            label: "Castellano",
            icon: locale === "es" ? <Check size={16} /> : undefined,
            current: locale === "es",
            disabled: pending,
            onSelect: () => locale !== "es" && update({ locale: "es" }),
          },
          {
            label: t("Modo claro", "Modo claro"),
            separatorBefore: true,
            icon: <Sun size={16} />,
            current: theme === "light",
            disabled: pending,
            onSelect: () => theme !== "light" && update({ theme: "light" }),
          },
          {
            label: t("Modo oscuro", "Modo escuro"),
            icon: <Moon size={16} />,
            current: theme === "dark",
            disabled: pending,
            onSelect: () => theme !== "dark" && update({ theme: "dark" }),
          },
          {
            label: t("Sistema", "Sistema"),
            icon: <Monitor size={16} />,
            current: theme === "system",
            disabled: pending,
            onSelect: () => theme !== "system" && update({ theme: "system" }),
          },
          {
            label: t("Tema del municipio", "Tema do municipio"),
            current: theme === null,
            disabled: pending,
            onSelect: () => theme !== null && update({ theme: null }),
          },
          ...(account
            ? [
                {
                  label: t("Cerrar sesión", "Pechar sesión"),
                  separatorBefore: true,
                  icon: <LogOut size={16} />,
                  disabled: leaving,
                  onSelect: () => void leave(),
                },
              ]
            : []),
        ]}
      />
      {error !== undefined && <Failure error={error} />}
    </div>
  );
}
