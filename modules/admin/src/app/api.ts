import type {
  AdminProject,
  AdminRequestDetail,
  AdminRequestList,
  IntegrationKind,
  IntegrationStatus,
  MintedKey,
  StaffIdentity,
} from "@pw-support/contracts";
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { createContext, useContext } from "react";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  download(path: string, filename: string): Promise<void>;
}

export function createApiClient(options: {
  baseUrl: string;
  token: () => string | null;
  onUnauthorized: () => void;
}): ApiClient {
  async function send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const token = options.token();
    if (!token) {
      options.onUnauthorized();
      throw new ApiError(401, "unauthorized");
    }
    const response = await fetch(`${options.baseUrl}/admin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) options.onUnauthorized();
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ApiError(response.status, detail?.error ?? "request_failed");
    }
    return response;
  }
  return {
    async request<T>(method: string, path: string, body?: unknown) {
      return (await send(method, path, body)).json() as Promise<T>;
    },
    async download(path, filename) {
      const blob = await (await send("GET", path)).blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    },
  };
}

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useApi needs an ApiContext");
  return client;
}

export interface RequestFilters {
  projectId?: string;
  status?: string;
  flaggedReplies?: boolean;
  needsHuman?: boolean;
}

function filterQuery(filters: RequestFilters, cursor?: string): string {
  const params = new URLSearchParams({ limit: "25" });
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.status) params.set("status", filters.status);
  if (filters.flaggedReplies) params.set("flaggedReplies", "true");
  if (filters.needsHuman) params.set("needsHuman", "true");
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export const queries = {
  me: (api: ApiClient) =>
    queryOptions({
      queryKey: ["me"],
      queryFn: () => api.request<StaffIdentity>("GET", "/me"),
    }),
  requests: (api: ApiClient, filters: RequestFilters) =>
    infiniteQueryOptions({
      queryKey: ["requests", filters],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) =>
        api.request<AdminRequestList>(
          "GET",
          `/requests?${filterQuery(filters, pageParam)}`,
        ),
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  request: (api: ApiClient, id: string) =>
    queryOptions({
      queryKey: ["request", id],
      queryFn: () => api.request<AdminRequestDetail>("GET", `/requests/${id}`),
    }),
  projects: (api: ApiClient) =>
    queryOptions({
      queryKey: ["projects"],
      queryFn: () => api.request<AdminProject[]>("GET", "/projects"),
    }),
  integrations: (api: ApiClient) =>
    queryOptions({
      queryKey: ["integrations"],
      queryFn: () => api.request<IntegrationStatus[]>("GET", "/integrations"),
    }),
};

export function useProjectMutations() {
  const api = useApi();
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["projects"] });
  return {
    create: useMutation({
      mutationFn: (input: {
        clientSlug: string;
        projectSlug: string;
        name: string;
        linearTeamId?: string | null;
      }) => api.request<AdminProject>("POST", "/projects", input),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: (input: {
        id: string;
        name?: string;
        linearTeamId?: string | null;
      }) => {
        const { id, ...body } = input;
        return api.request<AdminProject>("PATCH", `/projects/${id}`, body);
      },
      onSuccess: refresh,
    }),
    ccList: useMutation({
      mutationFn: (input: { id: string; emails: string[] }) =>
        api.request<AdminProject>("PUT", `/projects/${input.id}/cc-list`, {
          emails: input.emails,
        }),
      onSuccess: refresh,
    }),
    mintKey: useMutation({
      mutationFn: (id: string) =>
        api.request<MintedKey>("POST", `/projects/${id}/keys`),
      onSuccess: refresh,
    }),
    revokeKey: useMutation({
      mutationFn: (input: { id: string; keyId: string }) =>
        api.request<AdminProject>(
          "POST",
          `/projects/${input.id}/keys/${input.keyId}/revoke`,
        ),
      onSuccess: refresh,
    }),
  };
}

export function useSaveIntegration() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: IntegrationKind; value: string }) =>
      api.request<IntegrationStatus>("PUT", `/integrations/${input.kind}`, {
        value: input.value,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["integrations"] }),
  });
}
