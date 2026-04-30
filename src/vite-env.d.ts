/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SMS_WORKER_BASE_URL?: string
  readonly VITE_SMS_WORKER_SECRET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
