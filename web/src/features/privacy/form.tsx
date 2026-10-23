import { useQueryClient } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { ConfirmedAction } from "../../app/confirmed-action";
import { useSession } from "../../app/session";
import { usePrivacyScope } from "./context";
export function PrivacyForm<T>({
  onResult,
  ...props
}: Omit<ComponentProps<typeof ConfirmedAction<T>>, "storageKey">) {
  const { account } = useSession();
  const scope = usePrivacyScope();
  const client = useQueryClient();
  return (
    <ConfirmedAction<T>
      {...props}
      storageKey={`quenda.privacy-uncertain:${account?.accountId}:${scope.base}`}
      onResult={async (result) => {
        await client.invalidateQueries({
          queryKey: ["private", account?.accountId, "privacy", scope.base],
        });
        await onResult(result);
      }}
    />
  );
}
