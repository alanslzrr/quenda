import { useQuery } from "@tanstack/react-query";
import {
  LockKeyhole,
  Mail,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { SettingsLayout } from "../../ui/blocks/settings-page/settings-layout";
import { PasswordField } from "../../ui/password-field/password-field";

export function RequireAccount() {
  const { account, loading, error } = useSession();
  const location = useLocation();
  if (loading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!account)
    return (
      <Navigate
        to={`/acceso?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`}
        replace
      />
    );
  return <Outlet />;
}
export function AccountLayout() {
  const { pathname } = useLocation();
  const { account } = useSession();
  useMunicipalTheme(undefined);
  const { t } = usePreferences();
  if (pathname === "/perfil/seguridad")
    return (
      <SettingsLayout
        title={t("Mi cuenta", "A miña conta")}
        email={account?.email ?? ""}
        links={[
          {
            to: "/perfil",
            label: t("Preferencias", "Preferencias"),
            icon: <SlidersHorizontal size={16} aria-hidden="true" />,
          },
          {
            to: "/perfil/datos",
            label: t("Datos personales", "Datos persoais"),
            icon: <UserRound size={16} aria-hidden="true" />,
          },
          {
            to: "/perfil/seguridad",
            label: t("Seguridad", "Seguridade"),
            icon: <ShieldCheck size={16} aria-hidden="true" />,
          },
          {
            to: "/perfil/privacidad",
            label: t("Privacidad y baja", "Privacidade e baixa"),
            icon: <LockKeyhole size={16} aria-hidden="true" />,
          },
          {
            to: "/perfil/invitaciones",
            label: t("Invitaciones", "Invitacións"),
            icon: <Mail size={16} aria-hidden="true" />,
          },
        ]}
      >
        <Outlet />
      </SettingsLayout>
    );
  return (
    <>
      <nav
        className={styles.tabs}
        aria-label={t("Configuración de cuenta", "Configuración da conta")}
      >
        <Link to="/perfil">{t("Preferencias", "Preferencias")}</Link>
        <Link to="/perfil/datos">
          {t("Datos personales", "Datos persoais")}
        </Link>
        <Link to="/perfil/seguridad">{t("Seguridad", "Seguridade")}</Link>
        <Link to="/perfil/privacidad">
          {t("Privacidad y baja", "Privacidade e baixa")}
        </Link>
        <Link to="/perfil/invitaciones">
          {t("Invitaciones", "Invitacións")}
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
export function PageTitle({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.hero}>
      <h1 className={styles.title}>{title}</h1>
      {children && <p className={styles.description}>{children}</p>}
    </div>
  );
}
export function SecretField(props: ComponentProps<typeof PasswordField>) {
  const { t } = usePreferences();
  return (
    <PasswordField
      required
      maxLength={128}
      autoComplete="current-password"
      {...props}
      messages={{
        showPassword: t("Mostrar contraseña", "Mostrar contrasinal"),
        hidePassword: t("Ocultar contraseña", "Ocultar contrasinal"),
      }}
    />
  );
}
export interface AuthSession {
  user: { id: string; name: string; email: string; twoFactorEnabled?: boolean };
  session: { token: string; createdAt: string; expiresAt: string };
}
export function useAuthSession() {
  const { account } = useSession();
  return useQuery({
    queryKey: ["private", account?.accountId, "auth-session"],
    enabled: !!account,
    queryFn: ({ signal }) =>
      api<AuthSession>("/api/auth/get-session", { signal }),
    retry: false,
    gcTime: 0,
  });
}
export function safeReturnPath(value: string | null) {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    return "/perfil";
  return value.startsWith("/acceso") || value.startsWith("/registro")
    ? "/perfil"
    : value;
}
