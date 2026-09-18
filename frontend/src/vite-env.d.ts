/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' enables the dev-only API/live mock (npm run dev:mock). */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
