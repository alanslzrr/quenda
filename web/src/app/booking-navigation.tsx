import { motion } from "motion/react";
import { Link, useLocation } from "react-router";
import { useBookingEntry } from "../features/catalog/journey";
import { motionTokens } from "../ui/motion-tokens";
import styles from "./layout.module.css";
import { usePreferences } from "./preferences-provider";
import { useSession } from "./session";

export function BookingNavigation() {
  const { account } = useSession();
  const { t } = usePreferences();
  const entry = useBookingEntry();
  const { pathname } = useLocation();
  if (!account) return null;
  const history = pathname === "/reservas" || pathname.startsWith("/reservas/");
  // One highlight slides between the two tabs, so switching reads as moving within the same place.
  const mark = (
    <motion.span
      layoutId="booking-tab"
      className={styles.bookingMark}
      transition={motionTokens.spring.snappy}
      aria-hidden="true"
    />
  );
  return (
    <nav
      className={styles.bookingNav}
      aria-label={t("Tus reservas", "As túas reservas")}
    >
      <Link to={entry} aria-current={!history ? "page" : undefined}>
        {!history && mark}
        <span>{t("Nueva reserva", "Nova reserva")}</span>
      </Link>
      <Link to="/reservas" aria-current={history ? "page" : undefined}>
        {history && mark}
        <span>{t("Mis reservas", "As miñas reservas")}</span>
      </Link>
    </nav>
  );
}
