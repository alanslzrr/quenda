import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { openAPI, twoFactor } from "better-auth/plugins";
import { PostgresDialect } from "kysely";
import type { Pool } from "pg";
import { HttpError, language } from "../../http/errors.ts";
import type { MailTransport } from "../../shared/mail.ts";
import { normalizedAccountName } from "./account-profile.ts";
import { accountEmailChange } from "./email-change.ts";
import { accountReactivation } from "./reactivation.ts";
import { auditedAuthenticationHandler } from "./request-audit.ts";

export interface AuthConfiguration {
  origin: string;
  secret: string;
  /** Send `Clear-Site-Data: "cookies"` after a successful sign-out; off by default. */
  clearSiteCookiesOnSignOut?: boolean;
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
        {
          user,
          url,
          token,
        }: {
          user: { id: string; email: string };
          url: string;
          token: string;
        },
        request?: Request,
      ) => {
        // Better Auth reads the user before creating the reset token. A concurrent
        // email change must not deliver a newly issued token to the old mailbox.
        const current = await pool.query(
          `SELECT 1 FROM auth."user" u JOIN auth.account_lifecycle l ON l.account_id=u.id
           WHERE u.id=$1 AND u.email=$2 AND l.deactivated_at IS NULL AND l.suspended_at IS NULL`,
          [user.id, user.email],
        );
        if (!current.rowCount) {
          await pool.query(
            "DELETE FROM auth.verification WHERE identifier=$1 AND value=$2",
            [`reset-password:${token}`, user.id],
          );
          return;
        }
        await sendLink("reset", user.email, url, request);
      },
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
              "SELECT 1 FROM auth.account_lifecycle WHERE account_id=$1 AND deactivated_at IS NULL AND suspended_at IS NULL",
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
        if (ctx.path === "/two-factor/disable") {
          const session = await getAuthoritativeSessionFromCtx(ctx);
          if (session) {
            const authority = await pool.query<{ required: boolean }>(
              "SELECT auth.account_has_administrative_authority($1) AS required",
              [session.user.id],
            );
            if (authority.rows[0]?.required)
              throw new APIError("FORBIDDEN", {
                code: "MFA_REQUIRED_FOR_ADMINISTRATION",
                message:
                  "Transfer or relinquish administrative permissions before disabling MFA",
              });
          }
        }
        if (ctx.path === "/update-user") {
          const name = normalizedAccountName(ctx.body);
          if (name === null)
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_INPUT",
              message: "Invalid profile fields",
            });
          ctx.body.name = name;
        }
        if (ctx.path === "/sign-up/email") {
          // Registration stores the same bounded name as profile editing and
          // never an arbitrary avatar reference.
          const name = normalizedAccountName({ name: ctx.body?.name });
          if (name === null)
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_INPUT",
              message: "Invalid profile fields",
            });
          ctx.body.name = name;
          delete ctx.body.image;
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
    ...accountEmailChange(
      pool,
      mail,
      config.origin,
      (headers) => auth.api.getSession({ headers }),
      (headers, password) =>
        auth.api.verifyPassword({ headers, body: { password } }),
    ),
    ...accountReactivation(
      pool,
      mail,
      config.origin,
      config.secret,
      async () => (await auth.$context).password,
    ),
    async verifyDeactivation(headers: Headers, password: string) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user.emailVerified) throw new HttpError("UNAUTHENTICATED");
      const credential = (
        await pool.query<{ password: string }>(
          `SELECT password FROM auth.account
           WHERE "userId"=$1 AND "providerId"='credential' AND password IS NOT NULL`,
          [session.user.id],
        )
      ).rows[0];
      if (!credential) throw new HttpError("ACCOUNT_PASSWORD_REQUIRED");
      // Password checks made on the server bypass the HTTP limiter of Better
      // Auth, so a held session must not become an unbounded password oracle.
      const limit = await pool.query<{ allowed: boolean }>(
        "SELECT auth.consume_reactivation_attempt($1,20) AS allowed",
        [
          `deactivation:${createHash("sha256").update(session.user.id).digest("hex")}`,
        ],
      );
      if (!limit.rows[0]?.allowed) throw new HttpError("RATE_LIMITED");
      try {
        await auth.api.verifyPassword({ headers, body: { password } });
      } catch (error) {
        if (error instanceof APIError)
          throw new HttpError("ACCOUNT_PASSWORD_REQUIRED");
        throw error;
      }
      const token = randomBytes(32).toString("base64url");
      const issued = await pool.query<{ issued: boolean }>(
        "SELECT auth.issue_deactivation_proof($1,$2,$3,$4) AS issued",
        [
          session.user.id,
          session.session.id,
          credential.password,
          createHash("sha256").update(token).digest("hex"),
        ],
      );
      if (!issued.rows[0]?.issued)
        throw new HttpError("ACCOUNT_PASSWORD_REQUIRED");
      return token;
    },
    handler: auditedAuthenticationHandler(
      pool,
      auth.handler,
      async (headers) => {
        const session = await auth.api.getSession({ headers });
        return session?.user.emailVerified ? session.user.id : null;
      },
    ),
    schema: () => auth.api.generateOpenAPISchema(),
    async authenticate(headers: Headers): Promise<AuthenticatedAccount | null> {
      const result = await auth.api.getSession({ headers });
      if (!result?.user.emailVerified) return null;
      const proof = await pool.query<{
        verified: Date | null;
        enabled: boolean;
      }>(
        'SELECT s."mfaVerifiedAt" AS verified, u."twoFactorEnabled" AS enabled FROM auth.session s JOIN auth."user" u ON u.id = s."userId" JOIN auth.account_lifecycle l ON l.account_id=u.id AND l.deactivated_at IS NULL AND l.suspended_at IS NULL WHERE s.id = $1 AND s."userId" = $2 AND s."expiresAt" > now()',
        [result.session.id, result.user.id],
      );
      if (!proof.rows[0]) return null;
      return {
        accountId: result.user.id,
        email: result.user.email,
        sessionId: result.session.id,
        mfaVerifiedAt: proof.rows[0].enabled ? proof.rows[0].verified : null,
        mfaEnabled: proof.rows[0].enabled,
      };
    },
  };
}

export type Authentication = ReturnType<typeof createAuthentication>;
export interface AuthenticatedAccount {
  accountId: string;
  email: string;
  sessionId: string;
  mfaVerifiedAt: Date | null;
  /** MFA is configured on the account, whether or not this session proved it. */
  mfaEnabled?: boolean;
}
