import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LockKeyhole,
  Mail,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { ApiError, api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { discardEditor, EditorRecovery } from "../../app/read-recovery";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { SettingsLayout } from "../../ui/blocks/settings-page/settings-layout";
import { PasswordField } from "../../ui/password-field/password-field";

export function RequireAccount() {
  const { account, loading, error, refresh } = useSession();
  const location = useLocation();
  if (loading) return <Loading />;
  if (error && (!account || discardEditor(error)))
    return (
      <Failure error={error} retry={() => void refresh().catch(() => {})} />
    );
  if (!account)
    return (
      <Navigate
        to={`/acceso?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`}
        replace
      />
    );
  return (
    <EditorRecovery error={error} retry={() => void refresh().catch(() => {})}>
      <Outlet key={account.accountId} />
    </EditorRecovery>
  );
}
export function AccountLayout() {
  const { account } = useSession();
  useMunicipalTheme(undefined);
  const { t } = usePreferences();
  return (
    <SettingsLayout
      title={t("Mi cuenta", "A miña conta")}
      email={account?.email ?? ""}
      // Only the account's own settings: reservations and notices are their own pages,
      // reached from the booking tabs and the settings menu.
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
  const { locale, t } = usePreferences();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["private", account?.accountId, "auth-session"],
    enabled: !!account,
    queryFn: async ({ signal }) => {
      // better-auth answers 200 with a null body once the session is gone.
      const session = await api<AuthSession | null>(
        "/api/auth/get-session",
        { signal },
        locale,
      );
      if (!session)
        throw new ApiError(
          401,
          "UNAUTHENTICATED",
          t(
            "Tu sesión ya no está activa. Accede de nuevo.",
            "A túa sesión xa non está activa. Accede de novo.",
          ),
        );
      return session;
    },
    retry: false,
    gcTime: 0,
  });
  const lost = query.error instanceof ApiError && query.error.status === 401;
  useEffect(() => {
    // Let the account session resolve so protected routes send the person to sign in.
    if (lost) void client.invalidateQueries({ queryKey: ["session"] });
  }, [lost, client]);
  return query;
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
