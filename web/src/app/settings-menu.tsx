import { Check, Moon, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { DropdownMenu } from "../ui/dropdown-menu/dropdown-menu";
import { Failure } from "./feedback";
import { usePreferences } from "./preferences-provider";
export function SettingsMenu() {
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
        icon={<Settings size={17} />}
        items={[
          {
            label: "Galego",
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
        ]}
      />
      {error !== undefined && <Failure error={error} />}
    </div>
  );
}
