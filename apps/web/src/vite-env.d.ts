/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The assistant's name, from ASSISTANT_NAME in the root .env (see vite.config.ts). */
  readonly ASSISTANT_NAME: string;
}
