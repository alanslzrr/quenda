import { Check, LogOut, Moon, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { DropdownMenu } from "../ui/dropdown-menu/dropdown-menu";
import { Failure } from "./feedback";
import { usePreferences } from "./preferences-provider";
import { useSession } from "./session";

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
  const update = (value: Parameters<typeof save>[0]) => {
    setError(undefined);
    void save(value).catch(setError);
  };
  return (
    <div>
      <DropdownMenu
        label={t("Ajustes", "Axustes")}
        icon={<Settings size={16} />}
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
                },
              ]
            : []),
          {
            label: "Galego",
            separatorBefore: !!account,
            icon: locale === "gl" ? <Check size={16} /> : undefined,
            disabled: pending,
            onSelect: () => update({ locale: "gl" }),
          },
          {
            label: "Castellano",
            icon: locale === "es" ? <Check size={16} /> : undefined,
            disabled: pending,
            onSelect: () => update({ locale: "es" }),
          },
          {
            label: t("Modo claro", "Modo claro"),
            separatorBefore: true,
            icon: <Sun size={16} />,
            disabled: pending || theme === "light",
            onSelect: () => update({ theme: "light" }),
          },
          {
            label: t("Modo oscuro", "Modo escuro"),
            icon: <Moon size={16} />,
            disabled: pending || theme === "dark",
            onSelect: () => update({ theme: "dark" }),
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
