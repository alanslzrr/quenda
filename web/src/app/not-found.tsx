import { Link } from "react-router";
import { usePreferences } from "./preferences-provider";
import { useMunicipalTheme } from "./theme-provider";

export function NotFound() {
  useMunicipalTheme(undefined);
  const { t } = usePreferences();
  return (
    <>
      <h1>{t("Página no encontrada", "Páxina non atopada")}</h1>
      <Link to="/">{t("Volver al inicio", "Volver ao inicio")}</Link>
    </>
  );
}
