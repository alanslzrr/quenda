import { Building2, CalendarPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useMatch, useParams } from "react-router";
import { MfaBoundary, MfaNotice } from "../features/account/mfa-dialog";
import {
  forgetJourneyOutside,
  useBookingEntry,
} from "../features/catalog/journey";
import { useMunicipality } from "../features/catalog/municipality";
import { kindShort, kinds, noticePath } from "../features/legal/notices";
import { Announcer } from "./announce";
import { BookingNavigation } from "./booking-navigation";
import { Failure } from "./feedback";
import { hasInvalidIds, isUuid } from "./ids.ts";
import styles from "./layout.module.css";
import { NotFound } from "./not-found";
import { usePreferences } from "./preferences-provider";
import { useSession } from "./session";
import { SettingsMenu } from "./settings-menu";
import { useStaffEntry } from "./staff-entry";

export function Layout() {
  const { t, locale } = usePreferences();
  const { account } = useSession();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const [titleRoot, setTitleRoot] = useState<HTMLElement | null>(null);
  const bindMain = useCallback((node: HTMLElement | null) => {
    main.current = node;
    setTitleRoot(node);
  }, []);
  const previous = useRef(location.pathname);
  const params = useParams();
  const place = useMatch("/municipios/:tenantId/*");
  // A malformed id is shown as not found and must not be requested.
  const tenantId = isUuid(place?.params.tenantId)
    ? place?.params.tenantId
    : undefined;
  const municipality = useMunicipality(tenantId);
  useEffect(() => {
    forgetJourneyOutside(location.pathname);
    if (previous.current !== location.pathname) {
      previous.current = location.pathname;
      main.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }, [location.pathname]);
  useEffect(() => {
    const target = titleRoot;
    if (!target) return;
    const update = () => {
      const headings = Array.from(target.querySelectorAll("h1, h2"))
        .filter((node) => !node.closest("[hidden], [aria-hidden=true]"))
        .slice(0, 2)
        .map((node) => node.textContent?.trim())
        .filter(Boolean);
      document.title = [...new Set(headings), "Quenda"].join(" · ");
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(target, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [titleRoot]);
  const resource = /^\/administracion\/[^/]+(?:\/|$)/.test(location.pathname);
  const name = tenantId ? municipality.data?.name : undefined;
  const entry = useBookingEntry();
  const booking =
    location.pathname === "/" ||
    location.pathname === "/reservar" ||
    location.pathname.startsWith("/municipios/");
  const staff = useStaffEntry(account?.accountId, !resource, locale);
  // Pages outside the management workspace share one centred column, so sign-in,
  // notices, errors and platform pages line up with booking. Account settings
  // already draw their own centred card and keep the wider frame.
  const ownCard = /^\/perfil(?:\/|$)/.test(location.pathname);
  return (
    <MfaBoundary key={account?.accountId ?? "guest"}>
      <div className={`${styles.shell} ${styles.product}`}>
        <Announcer />
        <a className={styles.skip} href="#content">
          {t("Saltar al contenido", "Saltar ao contido")}
        </a>
        {!resource && (
          <header
            className={styles.header}
            data-account={!!account || undefined}
            data-place={!!name || undefined}
          >
            <Link
              className={styles.brand}
              to={tenantId ? `/municipios/${tenantId}` : "/"}
            >
              <span className={styles.brandMark} aria-hidden="true">
                q
              </span>
              <span className={styles.wordmark}>quenda</span>
              {name && (
                <>
                  <span className={styles.divider} aria-hidden="true">
                    /
                  </span>
                  <span className={styles.place}>{name}</span>
                </>
              )}
            </Link>
            <nav
              className={styles.nav}
              aria-label={t("Navegación principal", "Navegación principal")}
            >
              <Link
                to={entry}
                className={styles.navItem}
                data-primary=""
                aria-current={
                  booking || location.pathname.startsWith("/reservas")
                    ? "page"
                    : undefined
                }
              >
                <CalendarPlus size={16} aria-hidden="true" />
                {t("Reservar", "Reservar")}
              </Link>
              {staff.to && (
                <Link
                  to={staff.to}
                  className={styles.navItem}
                  data-staff=""
                  aria-current={
                    /^\/(administracion|plataforma)(\/|$)/.test(
                      location.pathname,
                    )
                      ? "page"
                      : undefined
                  }
                >
                  <Building2 size={16} aria-hidden="true" />
                  {t("Gestión", "Xestión")}
                </Link>
              )}
            </nav>
            <div className={styles.tools}>
              {!account && (
                <Link className={styles.signIn} to="/acceso">
                  {t("Acceder", "Acceder")}
                </Link>
              )}
              <SettingsMenu />
            </div>
          </header>
        )}
        <main
          id="content"
          ref={bindMain}
          tabIndex={-1}
          className={
            resource
              ? styles.workspaceMain
              : `${styles.main} ${ownCard ? "" : styles.columnMain}`
          }
        >
          {staff.error && (
            <section aria-label={t("Acceso a gestión", "Acceso á xestión")}>
              <p>
                {t(
                  "No hemos podido comprobar tus opciones de gestión. Puedes seguir usando el resto de la aplicación.",
                  "Non puidemos comprobar as túas opcións de xestión. Podes seguir usando o resto da aplicación.",
                )}
              </p>
              <Failure
                error={staff.error}
                retry={staff.retry}
                retryLabel={t(
                  "Reintentar acceso a gestión",
                  "Volver comprobar o acceso á xestión",
                )}
              />
            </section>
          )}
          {(booking || location.pathname.startsWith("/reservas")) && (
            <BookingNavigation />
          )}
          {!resource && <MfaNotice />}
          {hasInvalidIds(params) ? <NotFound /> : <Outlet />}
        </main>
        {!resource && (
          <footer className={styles.footer}>
            Quenda ·{" "}
            {t(
              "Instalaciones deportivas municipales",
              "Instalacións deportivas municipais",
            )}
            <nav
              className={styles.legalLinks}
              aria-label={t("Información legal", "Información legal")}
            >
              {kinds.map((kind) => (
                <Link key={kind} to={noticePath(kind, tenantId)}>
                  {kindShort[kind][locale === "gl" ? 1 : 0]}
                </Link>
              ))}
            </nav>
          </footer>
        )}
      </div>
    </MfaBoundary>
  );
}
