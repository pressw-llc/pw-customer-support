import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "@/app/App";
import { ApiContext, ApiError, createApiClient } from "@/app/api";
import { AuthProvider, useAuth } from "@/app/auth";
import { ConfigProblem, Notice } from "@/app/states";
import {
  type AdminConfig,
  configProblems,
  loadRuntimeConfig,
  resolveConfig,
} from "@/lib/config";
import "@/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) =>
        !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

function Gate({ config }: { config: AdminConfig }) {
  const auth = useAuth();
  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: config.apiUrl,
        token: auth.token,
        onUnauthorized: () => void auth.login(),
      }),
    [config.apiUrl, auth.token, auth.login],
  );
  if (auth.status === "authenticated") {
    return (
      <ApiContext.Provider value={api}>
        <App />
      </ApiContext.Provider>
    );
  }
  if (auth.status === "error") {
    return (
      <Notice
        tone="error"
        title="Sign-in failed"
        action={{ label: "Try again", onClick: () => void auth.login() }}
      >
        {auth.error}
      </Notice>
    );
  }
  if (auth.status === "signedOut") {
    return (
      <Notice
        title="You are signed out"
        action={{ label: "Sign in", onClick: () => void auth.login() }}
      >
        Sign in again to manage support requests.
      </Notice>
    );
  }
  return <Notice title="Signing you in" />;
}

async function boot() {
  const runtime = await loadRuntimeConfig();
  const config = resolveConfig(
    import.meta.env as unknown as Record<string, string | undefined>,
    runtime,
    window.location.origin,
  );
  const problems = configProblems(config);
  const root = createRoot(document.getElementById("root") as HTMLElement);
  root.render(
    <StrictMode>
      {problems.length > 0 ? (
        <ConfigProblem missing={problems} />
      ) : (
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider config={config}>
              <Gate config={config} />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      )}
    </StrictMode>,
  );
}

void boot();
