import { createHash, randomBytes } from "node:crypto";
import { APIError } from "better-auth/api";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { validMailbox } from "../../mail/config.ts";
import type { MailTransport } from "../../shared/mail.ts";

interface Session {
  user: { id: string; emailVerified: boolean };
  session: { id: string };
}
interface Credential {
  password: string;
  generation: string;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function sendEmailChangeLink(
  mail: MailTransport,
  origin: string,
  email: string,
  token: string,
  step: "approve" | "confirm",
  locale: "es" | "gl" = "es",
) {
  const url = new URL(`/account/email-change/${step}`, origin);
  url.hash = token;
  const subject =
    step === "approve"
      ? locale === "gl"
        ? "Autoriza o cambio de correo de Quenda"
        : "Autoriza el cambio de correo de Quenda"
      : locale === "gl"
        ? "Verifica o novo correo de Quenda"
        : "Verifica el nuevo correo de Quenda";
  await mail.send({
    to: email,
    subject,
    text: `${subject}\n\n${locale === "gl" ? "Abre a ligazón e confirma a operación desde a túa conta. A ligazón só pode usarse unha vez e caduca aos dez minutos da solicitude. Se non solicitaches este cambio, non o confirmes." : "Abre el enlace y confirma la operación desde tu cuenta. El enlace solo puede usarse una vez y caduca a los diez minutos de la solicitud. Si no solicitaste este cambio, no lo confirmes."}\n\n${url}`,
  });
}

export function accountEmailChange(
  pool: Pool,
  mail: MailTransport,
  origin: string,
  getSession: (headers: Headers) => Promise<Session | null>,
  verifyPassword: (headers: Headers, password: string) => Promise<unknown>,
) {
  const account = async (headers: Headers) => {
    const session = await getSession(headers);
    if (!session?.user.emailVerified) throw new HttpError("UNAUTHENTICATED");
    const limit = await pool.query<{ allowed: boolean }>(
      "SELECT auth.consume_reactivation_attempt($1,20) AS allowed",
      [`email-change:${digest(session.user.id)}`],
    );
    if (!limit.rows[0]?.allowed) throw new HttpError("RATE_LIMITED");
    return session;
  };
  const verify = async (
    headers: Headers,
    session: Session,
    password: string,
  ) => {
    const credential = (
      await pool.query<Credential>(
        `SELECT a.password,l.email_change_generation AS generation
       FROM auth.account a JOIN auth.account_lifecycle l ON l.account_id=a."userId"
       WHERE a."userId"=$1 AND a."providerId"='credential' AND a.password IS NOT NULL
       AND l.deactivated_at IS NULL AND l.suspended_at IS NULL`,
        [session.user.id],
      )
    ).rows[0];
    if (!credential) throw new HttpError("ACCOUNT_PASSWORD_REQUIRED");
    try {
      await verifyPassword(headers, password);
    } catch (error) {
      if (error instanceof APIError)
        throw new HttpError("ACCOUNT_PASSWORD_REQUIRED");
      throw error;
    }
    return credential;
  };
  const send = async (
    challenge: string,
    email: string,
    token: string,
    step: "approve" | "confirm",
    locale: "es" | "gl",
  ) => {
    try {
      await sendEmailChangeLink(mail, origin, email, token, step, locale);
    } catch {
      await pool.query("SELECT auth.revoke_email_change($1)", [challenge]);
      throw new HttpError("UNAVAILABLE");
    }
  };
  return {
    async requestEmailChange(
      headers: Headers,
      input: { newEmail: string; password: string },
      locale: "es" | "gl" = "es",
    ) {
      const session = await account(headers);
      const newEmail = input.newEmail.trim().toLowerCase();
      if (!validMailbox(newEmail)) throw new HttpError("INVALID_INPUT");
      const credential = await verify(headers, session, input.password);
      const token = randomBytes(32).toString("base64url");
      const result = await command(
        pool,
        undefined,
        async (client) =>
          (
            await client.query<{
              outcome: string;
              challenge_id: string | null;
              old_email: string | null;
            }>("SELECT * FROM auth.issue_email_change($1,$2,$3,$4,$5,$6)", [
              session.user.id,
              session.session.id,
              credential.password,
              newEmail,
              digest(token),
              credential.generation,
            ])
          ).rows[0],
      );
      if (!result) throw new HttpError("INTERNAL_ERROR");
      switch (result.outcome) {
        case "INACTIVE":
          throw new HttpError("ACCOUNT_INACTIVE");
        case "PROOF_REQUIRED":
          throw new HttpError("ACCOUNT_PASSWORD_REQUIRED");
        case "MFA_REQUIRED":
          throw new HttpError("REAUTHENTICATION_REQUIRED");
        case "INVALID":
          throw new HttpError("INVALID_INPUT");
      }
      if (result.challenge_id && result.old_email)
        await send(
          result.challenge_id,
          result.old_email,
          token,
          "approve",
          locale,
        );
    },
    async approveEmailChange(
      headers: Headers,
      input: { token: string },
      locale: "es" | "gl" = "es",
    ) {
      const session = await account(headers);
      const next = randomBytes(32).toString("base64url");
      const result = await command(
        pool,
        undefined,
        async (client) =>
          (
            await client.query<{ challenge_id: string; new_email: string }>(
              "SELECT * FROM auth.approve_email_change($1,$2,$3,$4)",
              [
                session.user.id,
                session.session.id,
                digest(input.token),
                digest(next),
              ],
            )
          ).rows[0],
      );
      if (!result) throw new HttpError("INVALID_INPUT");
      await send(
        result.challenge_id,
        result.new_email,
        next,
        "confirm",
        locale,
      );
    },
    async confirmEmailChange(
      headers: Headers,
      input: { token: string; password?: string },
      correlationId: string,
    ) {
      const session = await account(headers);
      const tokenDigest = digest(input.token);
      const challenge = (
        await pool.query<{ source: string }>(
          "SELECT source FROM auth.email_change_challenge WHERE verification_digest=$1 AND account_id=$2",
          [tokenDigest, session.user.id],
        )
      ).rows[0];
      if (!challenge) throw new HttpError("INVALID_INPUT");
      const credential =
        challenge.source === "ASSISTED"
          ? await verify(headers, session, input.password ?? "")
          : undefined;
      try {
        const result = await command(
          pool,
          undefined,
          async (client) =>
            (
              await client.query<{ instant: Date | null }>(
                "SELECT auth.complete_email_change($1,$2,$3,$4,$5) AS instant",
                [
                  session.user.id,
                  session.session.id,
                  tokenDigest,
                  credential?.password ?? null,
                  correlationId,
                ],
              )
            ).rows[0]?.instant,
        );
        if (!result) throw new HttpError("INVALID_INPUT");
        return {
          status: "EMAIL_CHANGED" as const,
          changedAt: result.toISOString(),
        };
      } catch (error) {
        if (error instanceof DatabaseError && error.code === "23505")
          throw new HttpError("CONFLICT");
        if (error instanceof DatabaseError && error.message === "MFA_REQUIRED")
          throw new HttpError("REAUTHENTICATION_REQUIRED");
        throw error;
      }
    },
  };
}
