import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ActionForm } from "../../app/action";
import { api } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import {
  type CommandPolicy,
  commandTime,
  readCommand,
  sendCommand,
} from "./commands";
import { PendingLink } from "./shared";

export function IdempotentAction<T>({
  path,
  body,
  label,
  children,
  onResult,
  danger = false,
  disabled = false,
  resetOnSuccess = false,
}: {
  path: string;
  body: (data: FormData) => unknown;
  label: string;
  children?: ReactNode;
  onResult?: (result: T) => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  resetOnSuccess?: boolean;
}) {
  const { account } = useSession();
  const { locale } = usePreferences();
  const client = useQueryClient();
  const [uncertain, setUncertain] = useState(false);
  if (uncertain || (account && readCommand(account.accountId)))
    return <PendingLink />;
  return (
    <ActionForm
      label={label}
      danger={danger}
      disabled={disabled || !account}
      resetOnSuccess={resetOnSuccess}
      submit={async (data) => {
        if (!account) return;
        const payload = JSON.stringify(body(data));
        const policy = await api<CommandPolicy>(
          "/api/public/reservation-command-policy",
          { signal: AbortSignal.timeout(15000) },
          locale,
        );
        const item = {
          owner: account.accountId,
          path,
          key: crypto.randomUUID(),
          body: payload,
          createdAt: commandTime(policy),
          retentionSeconds: policy.retentionSeconds,
        };
        try {
          const result = await sendCommand<T>(item, locale);
          await client.invalidateQueries({
            queryKey: [
              "private",
              account.accountId,
              path === "/api/municipalities" ? "platform" : "municipal",
            ],
          });
          await client.invalidateQueries({ queryKey: ["public"] });
          await onResult?.(result);
        } catch (error) {
          if (readCommand(account.accountId)) {
            setUncertain(true);
            return;
          }
          throw error;
        }
      }}
    >
      {children}
    </ActionForm>
  );
}
