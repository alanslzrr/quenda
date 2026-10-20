import { createHash, randomBytes } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import {
  constantTimeEqual,
  symmetricDecrypt,
  symmetricEncrypt,
} from "better-auth/crypto";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { MailTransport } from "../../shared/mail.ts";

interface PasswordVerifier {
  verify(data: { hash: string; password: string }): Promise<boolean>;
  hash(password: string): Promise<string>;
}

interface Credentials {
  id: string;
  email: string;
  password: string;
  mfa: boolean;
  secret: string | null;
  factor_id: string | null;
  backup_codes: string | null;
  verified: boolean | null;
  locked_until: Date | null;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function accountReactivation(
  pool: Pool,
  mail: MailTransport,
  origin: string,
  secret: string,
  getPassword: () => Promise<PasswordVerifier>,
) {
  // Equal-cost password work for missing, active and suspended accounts avoids
  // exposing existence or lifecycle state through the request endpoint.
  let absentHash: Promise<string> | undefined;
  const passwordMatches = async (
    password: string,
    credential?: Credentials,
  ) => {
    const verifier = await getPassword();
    absentHash ??= verifier.hash(randomBytes(32).toString("hex"));
    return verifier.verify({
      password,
      hash: credential?.password ?? (await absentHash),
    });
  };
  const consume = async (bucket: string, maximum: 5 | 20 | 30) => {
    const result = await pool.query<{ allowed: boolean }>(
      "SELECT auth.consume_reactivation_attempt($1,$2) AS allowed",
      [bucket, maximum],
    );
    return result.rows[0]?.allowed === true;
  };
  const credentialsSql = `
    SELECT u.id,u.email,a.password,coalesce(u."twoFactorEnabled",false) AS mfa,
      f.id AS factor_id,f.secret,f."backupCodes" AS backup_codes,
      f.verified,f."lockedUntil" AS locked_until
    FROM auth."user" u
    JOIN auth.account a ON a."userId"=u.id AND a."providerId"='credential'
    JOIN auth.account_lifecycle l ON l.account_id=u.id
    LEFT JOIN auth."twoFactor" f ON f."userId"=u.id
    WHERE u."emailVerified" AND a.password IS NOT NULL
      AND l.deactivated_at IS NOT NULL AND l.suspended_at IS NULL`;

  return {
    async requestReactivation(
      input: { email: string; password: string },
      ip: string,
      locale: "es" | "gl" = "es",
    ) {
      const email = input.email.trim().toLowerCase();
      const limits = await Promise.all([
        consume(`request-ip:${digest(ip)}`, 20),
        consume(`request-email:${digest(email)}`, 5),
      ]);
      if (!limits[0]) throw new HttpError("RATE_LIMITED");
      // Address limits deliberately have the same result as an unknown address.
      if (!limits[1]) return;
      const credential = (
        await pool.query<Credentials>(`${credentialsSql} AND u.email=$1`, [
          email,
        ])
      ).rows[0];
      if (!(await passwordMatches(input.password, credential)) || !credential)
        return;
      const token = randomBytes(32).toString("base64url");
      const inserted = await pool.query(
        `INSERT INTO auth.account_reactivation_challenge
         (token_digest,account_id,email,deactivated_at,expires_at)
         SELECT $1,l.account_id,u.email,l.deactivated_at,clock_timestamp()+interval '10 minutes'
         FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
         WHERE l.account_id=$2 AND u.email=$3 AND u."emailVerified"
         AND l.deactivated_at IS NOT NULL AND l.suspended_at IS NULL`,
        [digest(token), credential.id, credential.email],
      );
      if (!inserted.rowCount) return;
      const url = new URL("/account/reactivation", origin);
      // Fragments are not sent in HTTP requests or referrers. A future client
      // submits the token in the confirmation body, never in a mutation URL.
      url.hash = token;
      try {
        await mail.send({
          to: credential.email,
          subject:
            locale === "gl"
              ? "Reactiva a túa conta de Quenda"
              : "Reactiva tu cuenta de Quenda",
          text:
            (locale === "gl"
              ? "Confirma a reactivación co teu contrasinal e, se o tes habilitado, o teu segundo factor. A ligazón caduca en 10 minutos e só pode utilizarse unha vez."
              : "Confirma la reactivación con tu contraseña y, si lo tienes habilitado, tu segundo factor. El enlace caduca en 10 minutos y solo puede utilizarse una vez.") +
            `\n\n${url}`,
        });
      } catch {
        await pool.query(
          "DELETE FROM auth.account_reactivation_challenge WHERE token_digest=$1",
          [digest(token)],
        );
        throw new HttpError("UNAVAILABLE");
      }
    },

    async confirmReactivation(
      input: {
        token: string;
        password: string;
        totpCode?: string;
        backupCode?: string;
      },
      ip: string,
      correlationId: string,
    ) {
      if (!(await consume(`confirm-ip:${digest(ip)}`, 30)))
        throw new HttpError("RATE_LIMITED");
      if (input.totpCode && input.backupCode)
        throw new HttpError("INVALID_INPUT");
      const tokenDigest = digest(input.token);
      const subject = (
        await pool.query<{ account_id: string }>(
          "SELECT account_id FROM auth.account_reactivation_challenge WHERE token_digest=$1",
          [tokenDigest],
        )
      ).rows[0]?.account_id;
      if (!subject) throw new HttpError("INVALID_INPUT");
      if (!(await consume(`confirm-account:${digest(subject)}`, 5)))
        throw new HttpError("RATE_LIMITED");
      const reactivatedAt = await command(pool, undefined, async (client) => {
        const active = await client.query<{ locked: boolean }>(
          "SELECT auth.lock_reactivation_account($1) AS locked",
          [subject],
        );
        if (!active.rows[0]?.locked) return null;
        const challenge = await client.query(
          `UPDATE auth.account_reactivation_challenge c SET attempts=c.attempts+1
           FROM auth.account_lifecycle l
           WHERE c.token_digest=$1 AND c.account_id=$2 AND l.account_id=c.account_id
             AND c.deactivated_at=l.deactivated_at AND c.consumed_at IS NULL
             AND c.expires_at>clock_timestamp() AND c.attempts<5 RETURNING c.token_digest`,
          [tokenDigest, subject],
        );
        if (!challenge.rowCount) return null;
        const credential = (
          await client.query<Credentials>(`${credentialsSql} AND u.id=$1`, [
            subject,
          ])
        ).rows[0];
        if (!(await passwordMatches(input.password, credential)) || !credential)
          return null;
        let remainingBackupCodes: string | null = null;
        if (credential.mfa) {
          if (
            (!input.totpCode && !input.backupCode) ||
            !credential.secret ||
            !credential.factor_id ||
            credential.verified !== true ||
            (credential.locked_until &&
              credential.locked_until.getTime() > Date.now())
          )
            return null;
          if (input.backupCode) {
            if (!credential.backup_codes) return null;
            // Better Auth 1.7.11 stores backup codes as an encrypted JSON array.
            // Consume the existing code rather than issuing another MFA method.
            const codes: unknown = JSON.parse(
              await symmetricDecrypt({
                key: secret,
                data: credential.backup_codes,
              }),
            );
            if (
              !Array.isArray(codes) ||
              !codes.every((code) => typeof code === "string")
            )
              throw new Error("Invalid encrypted MFA backup codes");
            const selected = input.backupCode;
            if (!codes.some((code) => constantTimeEqual(code, selected)))
              return null;
            remainingBackupCodes = await symmetricEncrypt({
              key: secret,
              data: JSON.stringify(
                codes.filter((code) => !constantTimeEqual(code, selected)),
              ),
            });
          } else {
            const valid = await createOTP(
              await symmetricDecrypt({ key: secret, data: credential.secret }),
              { digits: 6, period: 30 },
            ).verify(input.totpCode ?? "");
            if (!valid) return null;
          }
        }
        const completed = await client.query<{ instant: Date | null }>(
          "SELECT auth.complete_account_reactivation($1,$2,$3) AS instant",
          [tokenDigest, subject, correlationId],
        );
        const instant = completed.rows[0]?.instant;
        if (!instant) return null;
        if (remainingBackupCodes !== null) {
          const consumed = await client.query(
            `UPDATE auth."twoFactor" SET "backupCodes"=$1
             WHERE id=$2 AND "userId"=$3 AND "backupCodes"=$4`,
            [
              remainingBackupCodes,
              credential.factor_id,
              subject,
              credential.backup_codes,
            ],
          );
          if (consumed.rowCount !== 1) throw new HttpError("CONFLICT");
        }
        return instant;
      });
      // Failed attempts commit their counter; no credential or lifecycle detail
      // is disclosed, and no session is created by this command.
      if (!reactivatedAt) throw new HttpError("INVALID_INPUT");
      return {
        status: "REACTIVATED" as const,
        reactivatedAt: reactivatedAt.toISOString(),
      };
    },
  };
}
