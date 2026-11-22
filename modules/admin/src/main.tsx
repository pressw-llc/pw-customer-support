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
        onUnauthorized: auth.unauthorized,
        onForbidden: auth.forbidden,
        onVerified: auth.verified,
      }),
    [
      config.apiUrl,
      auth.token,
      auth.unauthorized,
      auth.forbidden,
      auth.verified,
    ],
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
  if (auth.status === "forbidden") {
    return (
      <Notice
        tone="error"
        title="Not authorized for this desk"
        action={{ label: "Sign out", onClick: () => void auth.logout() }}
      >
        {auth.user?.profile.email
          ? `${auth.user.profile.email} is signed in, but this account is not allowed to use the support admin.`
          : "This account is signed in, but it is not allowed to use the support admin."}{" "}
        Sign out and use an account with access.
      </Notice>
    );
  }
  if (auth.status === "unverified") {
    return (
      <Notice
        tone="error"
        title="Sign-in could not be verified"
        action={{ label: "Try again", onClick: () => void auth.retry() }}
      >
        The support API did not accept your sign-in after a fresh login. Try
        again, or ask an administrator to check the API sign-in settings.
      </Notice>
    );
  }
  if (auth.status === "signedOut") {
    return (
      <Notice
        title="You are signed out"
        action={{ label: "Sign in", onClick: () => void auth.login() }}
      >
        {auth.idpSessionMayRemain
          ? "Your identity provider session may still be active. Close this browser to end it. Sign in again to manage support requests."
          : "Sign in again to manage support requests."}
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
