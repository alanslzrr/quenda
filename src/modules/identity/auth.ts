import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { openAPI, twoFactor } from "better-auth/plugins";
import { PostgresDialect } from "kysely";
import type { Pool } from "pg";
import { language } from "../../http/errors.ts";
import type { MailTransport } from "../../shared/mail.ts";
import { normalizedAccountName } from "./account-profile.ts";
import { auditedAuthenticationHandler } from "./request-audit.ts";

export interface AuthConfiguration {
  origin: string;
  secret: string;
}

export function authOptions(
  pool: Pool,
  config: AuthConfiguration,
  mail: MailTransport,
) {
  const sendLink = async (
    kind: "verify" | "reset",
    email: string,
    url: string,
    request?: Request,
  ) => {
    const gl =
      language(request?.headers.get("accept-language") ?? undefined) === "gl";
    const subject =
      kind === "verify"
        ? gl
          ? "Verifica o teu correo en Quenda"
          : "Verifica tu correo en Quenda"
        : gl
          ? "Restablece o teu contrasinal de Quenda"
          : "Restablece tu contraseña de Quenda";
    await mail.send({ to: email, subject, text: `${subject}\n\n${url}` });
  };
  return {
    appName: "Quenda",
    baseURL: config.origin,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: [config.origin],
    database: {
      dialect: new PostgresDialect({ pool }),
      type: "postgres" as const,
      schemaName: "auth",
      transaction: true,
    },
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async (
        { user, url }: { user: { email: string }; url: string },
        request?: Request,
      ) => sendLink("reset", user.email, url, request),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async (
        { user, url }: { user: { email: string }; url: string },
        request?: Request,
      ) => sendLink("verify", user.email, url, request),
    },
    session: {
      cookieCache: { enabled: false },
      additionalFields: {
        mfaVerifiedAt: {
          type: "date" as const,
          required: false,
          input: false,
          returned: false,
        },
      },
    },
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax" as const,
      },
      cookiePrefix: "quenda",
      ipAddress: { ipAddressHeaders: ["x-quenda-client-ip"] },
    },
    rateLimit: { enabled: true, storage: "database" as const },
    databaseHooks: {
      session: {
        create: {
          before: async (session: { userId: string }) => {
            const active = await pool.query(
              "SELECT 1 FROM auth.account_lifecycle WHERE account_id=$1 AND deactivated_at IS NULL",
              [session.userId],
            );
            if (!active.rowCount)
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_INACTIVE",
                message: "Account inactive",
              });
          },
        },
      },
    },
    plugins: [
      twoFactor({ issuer: "Quenda" }),
      openAPI({ disableDefaultReference: true }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/update-user") {
          const name = normalizedAccountName(ctx.body);
          if (name === null)
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_INPUT",
              message: "Invalid profile fields",
            });
          ctx.body.name = name;
        }
        if (ctx.body?.trustDevice === true) {
          throw new APIError("BAD_REQUEST", {
            message: "Trusted devices are not enabled",
            code: "TRUSTED_DEVICE_DISABLED",
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (
          ![
            "/two-factor/verify-totp",
            "/two-factor/verify-backup-code",
          ].includes(ctx.path)
        )
          return;
        const result: unknown = ctx.context.returned;
        if (
          !result ||
          typeof result !== "object" ||
          result instanceof APIError ||
          !("token" in result)
        )
          return;
        const session =
          ctx.context.newSession?.session ?? ctx.context.session?.session;
        if (!session) return;
        // A setting on the account is not proof that this session passed MFA.
        await pool.query(
          'UPDATE auth.session SET "mfaVerifiedAt" = now() WHERE id = $1 AND "userId" = $2 AND "expiresAt" > now()',
          [session.id, session.userId],
        );
      }),
    },
  };
}

export function createAuthentication(
  pool: Pool,
  config: AuthConfiguration,
  mail: MailTransport,
) {
  const auth = betterAuth(authOptions(pool, config, mail));
  return {
    handler: auditedAuthenticationHandler(
      pool,
      auth.handler,
      async (headers) => {
        const session = await auth.api.getSession({ headers });
        return session?.user.emailVerified ? session.user.id : null;
      },
    ),
    schema: () => auth.api.generateOpenAPISchema(),
    async authenticate(headers: Headers) {
      const result = await auth.api.getSession({ headers });
      if (!result?.user.emailVerified) return null;
      const proof = await pool.query<{
        verified: Date | null;
        enabled: boolean;
      }>(
        'SELECT s."mfaVerifiedAt" AS verified, u."twoFactorEnabled" AS enabled FROM auth.session s JOIN auth."user" u ON u.id = s."userId" JOIN auth.account_lifecycle l ON l.account_id=u.id AND l.deactivated_at IS NULL WHERE s.id = $1 AND s."userId" = $2 AND s."expiresAt" > now()',
        [result.session.id, result.user.id],
      );
      if (!proof.rows[0]) return null;
      return {
        accountId: result.user.id,
        email: result.user.email,
        sessionId: result.session.id,
        mfaVerifiedAt: proof.rows[0].enabled ? proof.rows[0].verified : null,
      };
    },
  };
}

export type Authentication = ReturnType<typeof createAuthentication>;
export type AuthenticatedAccount = NonNullable<
  Awaited<ReturnType<Authentication["authenticate"]>>
>;
