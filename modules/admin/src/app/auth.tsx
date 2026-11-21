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
import type { AdminConfig } from "@/lib/config";

type Status = "loading" | "authenticated" | "signedOut" | "error";

interface AuthValue {
  status: Status;
  user: User | null;
  error: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  token: () => string | null;
}

const AuthContext = createContext<AuthValue | null>(null);

const started = new WeakSet<UserManager>();
const CALLBACK_PATH = "/auth/callback";
const SIGNED_OUT_PATH = "/signed-out";

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
  const current = useRef<User | null>(null);

  const login = useCallback(async () => {
    await manager.signinRedirect({ state: returnPath() });
  }, [manager]);

  useEffect(() => {
    const loaded = (next: User) => {
      current.current = next;
      setUser(next);
      setStatus("authenticated");
    };
    const expired = () => {
      current.current = null;
      setUser(null);
      void manager.signinRedirect({ state: returnPath() });
    };
    manager.events.addUserLoaded(loaded);
    manager.events.addUserUnloaded(() => {
      current.current = null;
    });
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
          setStatus("signedOut");
          return;
        }
        const existing = await manager.getUser();
        if (existing && !existing.expired) {
          loaded(existing);
          return;
        }
        await login();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sign-in failed");
        setStatus("error");
      }
    }
    if (!started.has(manager)) {
      started.add(manager);
      void start();
    }
    return () => {
      manager.events.removeUserLoaded(loaded);
      manager.events.removeAccessTokenExpired(expired);
      manager.events.removeSilentRenewError(expired);
    };
  }, [manager, login]);

  const logout = useCallback(async () => {
    const metadata = await manager.metadataService
      .getMetadata()
      .catch(() => null);
    if (metadata?.end_session_endpoint) {
      await manager.signoutRedirect();
      return;
    }
    await manager.removeUser();
    current.current = null;
    setUser(null);
    window.history.replaceState(null, "", SIGNED_OUT_PATH);
    setStatus("signedOut");
  }, [manager]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      error,
      login: async () => {
        window.history.replaceState(null, "", "/");
        await manager.signinRedirect({ state: "/" });
      },
      logout,
      token: () => current.current?.id_token ?? null,
    }),
    [status, user, error, logout, manager],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth needs an AuthProvider");
  return value;
}
