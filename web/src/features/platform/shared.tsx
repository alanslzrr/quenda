import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { api, type Navigation, type Page } from "../../app/api";
import { ConfirmedAction } from "../../app/confirmed-action";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { blocksEditor, EditorRecovery } from "../../app/read-recovery";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Denied } from "../municipal/shared";
export const platformApi = "/api/platform";
export const platformView = "/plataforma/gestion";
export function OperatorGuard({ children }: { children: ReactNode }) {
  useMunicipalTheme(undefined);
  const { account } = useSession();
  const { locale } = usePreferences();
  const query = useQuery({
    queryKey: ["private", account?.accountId, "platform-context", locale],
    queryFn: ({ signal }) =>
      api<Navigation>("/api/me/navigation", { signal }, locale),
    retry: false,
  });
  if (query.isPending) return <Loading />;
  if (blocksEditor(query) || !query.data)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  return query.data.platform.operator ? (
    <EditorRecovery
      error={query.isError ? query.error : null}
      retry={() => void query.refetch()}
    >
      {children}
    </EditorRecovery>
  ) : (
    <Denied />
  );
}
export function usePlatformPages<T>(path: string) {
  const { account } = useSession();
  const { locale } = usePreferences();
  return useInfiniteQuery({
    queryKey: ["private", account?.accountId, "platform", path, locale],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api<Page<T>>(
        `${platformApi}/${path}${pageParam ? `?after=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    gcTime: 0,
  });
}
export function PlatformForm<T>({
  onResult,
  ...props
}: Omit<ComponentProps<typeof ConfirmedAction<T>>, "storageKey">) {
  const { account } = useSession();
  const client = useQueryClient();
  return (
    <ConfirmedAction<T>
      {...props}
      storageKey={`quenda.platform-uncertain:${account?.accountId}`}
      onResult={async (result) => {
        await onResult(result);
        await Promise.all(
          [
            "platform",
            "platform-context",
            "navigation",
            "municipal-context",
            "invitations",
            "privacy-navigation",
          ].map((key) =>
            client.invalidateQueries({
              queryKey: ["private", account?.accountId, key],
            }),
          ),
        );
        await client.invalidateQueries({ queryKey: ["public"] });
      }}
    />
  );
}
