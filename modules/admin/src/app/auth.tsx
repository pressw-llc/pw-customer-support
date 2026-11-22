import { type User, UserManager, WebStorageStateStore } from "oidc-client-ts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AdminConfig,
  logoutEndpoint,
  SIGNED_OUT_PATH,
} from "@/lib/config";
import {
  clearOidcStorage,
  idpSessionMayRemain,
  reloginAttempted,
} from "@/lib/session-flags";

type Status =
  | "loading"
  | "authenticated"
  | "signedOut"
  | "error"
  | "forbidden"
  | "unverified";

interface AuthValue {
  status: Status;
  user: User | null;
  error: string | null;
  idpSessionMayRemain: boolean;
  login: () => Promise<void>;
  retry: () => Promise<void>;
  logout: () => Promise<void>;
  token: () => string | null;
  unauthorized: () => void;
  forbidden: () => void;
  verified: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

const started = new WeakSet<UserManager>();
const CALLBACK_PATH = "/auth/callback";

export function createUserManager(config: AdminConfig): UserManager {
  return new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: `${config.origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: `${config.origin}${SIGNED_OUT_PATH}`,
    response_type: "code",
    scope: config.scope,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
    loadUserInfo: false,
  });
}

function returnPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function AuthProvider({
  config,
  children,
}: {
  config: AdminConfig;
  children: ReactNode;
}) {
  const manager = useMemo(() => createUserManager(config), [config]);
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idpMayRemain, setIdpMayRemain] = useState(idpSessionMayRemain.get());
  const current = useRef<User | null>(null);
  const redirecting = useRef(false);

  const redirectToLogin = useCallback(
    async (state: string) => {
      redirecting.current = true;
      try {
        await manager.signinRedirect({ state });
      } catch (cause) {
        redirecting.current = false;
        setError(messageOf(cause, "Sign-in failed"));
        setStatus("error");
      }
    },
    [manager],
  );

  const reauthenticate = useCallback(() => {
    if (redirecting.current) return;
    if (reloginAttempted.get()) {
      current.current = null;
      setStatus("unverified");
      return;
    }
    reloginAttempted.set(true);
    void redirectToLogin(returnPath());
  }, [redirectToLogin]);

  const login = useCallback(async () => {
    window.history.replaceState(null, "", "/");
    await redirectToLogin("/");
  }, [redirectToLogin]);

  const retry = useCallback(async () => {
    reloginAttempted.set(true);
    await login();
  }, [login]);

  useEffect(() => {
    const loaded = (next: User) => {
      current.current = next;
      setUser(next);
      setStatus("authenticated");
    };
    const expired = () => {
      current.current = null;
      setUser(null);
      reauthenticate();
    };
    const unloaded = () => {
      current.current = null;
    };
    manager.events.addUserLoaded(loaded);
    manager.events.addUserUnloaded(unloaded);
    manager.events.addAccessTokenExpired(expired);
    manager.events.addSilentRenewError(expired);

    async function start() {
      const path = window.location.pathname;
      try {
        if (path === CALLBACK_PATH) {
          const signedIn = await manager.signinRedirectCallback();
          loaded(signedIn);
          const target =
            typeof signedIn.state === "string" ? signedIn.state : "/";
          window.history.replaceState(null, "", target);
          return;
        }
        if (path === SIGNED_OUT_PATH) {
          await manager.clearStaleState().catch(() => undefined);
          setStatus("signedOut");
          return;
        }
        const existing = await manager.getUser();
        if (existing && !existing.expired) {
          loaded(existing);
          return;
        }
        await redirectToLogin(returnPath());
      } catch (cause) {
        setError(messageOf(cause, "Sign-in failed"));
        setStatus("error");
      }
    }
    if (!started.has(manager)) {
      started.add(manager);
      void start();
    }
    return () => {
      manager.events.removeUserLoaded(loaded);
      manager.events.removeUserUnloaded(unloaded);
      manager.events.removeAccessTokenExpired(expired);
      manager.events.removeSilentRenewError(expired);
    };
  }, [manager, redirectToLogin, reauthenticate]);

  const logout = useCallback(async () => {
    const idToken = current.current?.id_token;
    redirecting.current = true;
    await manager.revokeTokens().catch(() => undefined);
    await manager.removeUser().catch(() => undefined);
    clearOidcStorage();
    reloginAttempted.set(false);
    current.current = null;
    setUser(null);
    const metadata = await manager.metadataService
      .getMetadata()
      .catch(() => null);
    const fallback = logoutEndpoint(config);
    if (metadata && !metadata.end_session_endpoint && fallback) {
      metadata.end_session_endpoint = fallback;
    }
    if (metadata?.end_session_endpoint) {
      idpSessionMayRemain.set(false);
      setIdpMayRemain(false);
      await manager.signoutRedirect({ id_token_hint: idToken });
      return;
    }
    idpSessionMayRemain.set(true);
    setIdpMayRemain(true);
    redirecting.current = false;
    window.history.replaceState(null, "", SIGNED_OUT_PATH);
    setStatus("signedOut");
  }, [manager, config]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      error,
      idpSessionMayRemain: idpMayRemain,
      login: async () => {
        reloginAttempted.set(false);
        idpSessionMayRemain.set(false);
        setIdpMayRemain(false);
        await login();
      },
      retry,
      logout,
      token: () => current.current?.id_token ?? null,
      unauthorized: reauthenticate,
      forbidden: () => setStatus("forbidden"),
      verified: () => reloginAttempted.set(false),
    }),
    [status, user, error, idpMayRemain, login, retry, logout, reauthenticate],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth needs an AuthProvider");
  return value;
}
