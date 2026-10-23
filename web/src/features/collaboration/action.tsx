import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { ActionForm } from "../../app/action";
import { api } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import {
  type CommandPolicy,
  type CommandResult,
  commandResultPath,
  readCommand,
  sendCommand,
} from "../reservations/commands";
import { PendingLink } from "../reservations/shared";
export function CollaborationAction({
  path,
  body,
  label,
  children,
  danger = false,
  onResult,
}: {
  path: string;
  body: (data: FormData) => unknown;
  label: string;
  children: ReactNode;
  danger?: boolean;
  onResult?: (result: CommandResult) => void;
}) {
  const { account } = useSession();
  const { locale } = usePreferences();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  if (pending || (account && readCommand(account.accountId)))
    return <PendingLink />;
  return (
    <ActionForm
      label={label}
      danger={danger}
      resetOnSuccess={false}
      submit={async (data) => {
        if (!account) return;
        const content = JSON.stringify(body(data));
        const policy = await api<CommandPolicy>(
          "/api/public/reservation-command-policy",
          {},
          locale,
        );
        const command = {
          owner: account.accountId,
          path,
          key: crypto.randomUUID(),
          body: content,
          createdAt: Date.parse(policy.serverTime),
          retentionSeconds: policy.retentionSeconds,
        };
        try {
          const result = await sendCommand<CommandResult>(command, locale);
          await client.invalidateQueries({
            queryKey: ["private", account.accountId, "municipal"],
          });
          await client.invalidateQueries({ queryKey: ["public"] });
          if (onResult) onResult(result);
          else navigate(commandResultPath(command, result), { replace: true });
        } catch (error) {
          if (readCommand(account.accountId)) {
            setPending(true);
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
