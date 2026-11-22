const RELOGIN_KEY = "pw-support.relogin-attempted";
const IDP_SESSION_KEY = "pw-support.idp-session-may-remain";

function read(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string, value: boolean): void {
  try {
    if (value) window.sessionStorage.setItem(key, "1");
    else window.sessionStorage.removeItem(key);
  } catch {
    return;
  }
}

export const reloginAttempted = {
  get: () => read(RELOGIN_KEY),
  set: (value: boolean) => write(RELOGIN_KEY, value),
};

export const idpSessionMayRemain = {
  get: () => read(IDP_SESSION_KEY),
  set: (value: boolean) => write(IDP_SESSION_KEY, value),
};

export function clearOidcStorage(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index++) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith("oidc.")) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    return;
  }
}
