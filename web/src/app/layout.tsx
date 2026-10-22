import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Button } from "../ui/button/button";
import { Failure } from "./feedback";
import styles from "./layout.module.css";
import { usePreferences } from "./preferences-provider";
import { useSession } from "./session";
import { SettingsMenu } from "./settings-menu";
export function Layout() {
  const { t } = usePreferences();
  const { account, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const previous = useRef(location.pathname);
  useEffect(() => {
    if (previous.current !== location.pathname) {
      previous.current = location.pathname;
      main.current?.focus();
      window.scrollTo(0, 0);
    }
  }, [location.pathname]);
  async function leave() {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await signOut();
      window.location.replace("/");
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#content">
        {t("Saltar al contenido", "Saltar ao contido")}
      </a>
      <header className={styles.header}>
        <Link
          className={styles.brand}
          to="/"
          aria-label={t("Quenda, inicio", "Quenda, inicio")}
        >
          <span className={styles.brandMark} aria-hidden="true">
            q
          </span>
          quenda
        </Link>
        <nav
          className={styles.actions}
          aria-label={t("Navegación principal", "Navegación principal")}
        >
          {account ? (
            <>
              <Link to="/perfil">{t("Mi cuenta", "A miña conta")}</Link>
              <Button
                variant="ghost"
                size="sm"
                loading={busy}
                onClick={() => void leave()}
              >
                {t("Salir", "Saír")}
              </Button>
            </>
          ) : (
            <Link to="/acceso">{t("Acceder", "Acceder")}</Link>
          )}
          <SettingsMenu />
        </nav>
      </header>
      <main id="content" ref={main} tabIndex={-1} className={styles.main}>
        {failure !== undefined && <Failure error={failure} />}
        <Outlet />
      </main>
      <footer className={styles.footer}>
        <span>
          Quenda ·{" "}
          {t(
            "Instalaciones deportivas municipales",
            "Instalacións deportivas municipais",
          )}
        </span>
        <span>
          {t(
            "Una cuenta, varios municipios.",
            "Unha conta, varios municipios.",
          )}
        </span>
      </footer>
    </div>
  );
}
