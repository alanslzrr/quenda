import { Link, NavLink, useLocation } from "react-router";
import { useBookingEntry } from "../features/catalog/journey";
import styles from "./layout.module.css";
import { usePreferences } from "./preferences-provider";
import { useSession } from "./session";

export function BookingNavigation() {
  const { account } = useSession();
  const { t } = usePreferences();
  const entry = useBookingEntry();
  const { pathname } = useLocation();
  if (!account) return null;
  return (
    <nav
      className={styles.bookingNav}
      aria-label={t("Tus reservas", "As túas reservas")}
    >
      <Link
        to={entry}
        aria-current={!pathname.startsWith("/reservas") ? "page" : undefined}
      >
        {t("Nueva reserva", "Nova reserva")}
      </Link>
      <NavLink to="/reservas">{t("Mis reservas", "As miñas reservas")}</NavLink>
    </nav>
  );
}
