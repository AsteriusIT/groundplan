/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the backend API (empty in dev — requests go through the proxy). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
