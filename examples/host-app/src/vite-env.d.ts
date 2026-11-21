/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPPORT_PROJECT_KEY: string;
  readonly VITE_SUPPORT_USER_EMAIL: string;
  readonly VITE_SUPPORT_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
