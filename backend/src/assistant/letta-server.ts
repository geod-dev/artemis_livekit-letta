import { AppServerClient } from '@letta-ai/letta-code/app-server-client';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { config } from './config';

/**
 * The backend's own connection to the Letta server, for management commands
 * that are not part of a conversation: files in the Letta home (`read_file`,
 * `write_file`), skills (`skill_enable`/`skill_disable`) and `execute_command`
 * (mod reloads). The SDK's sessions do not expose these, so the backend keeps
 * one App Server connection of its own, reconnecting after a Letta restart,
 * and runs `onConnected` hooks on every connect (the files they render live
 * in the Letta volume and may be new).
 */

type ProtocolResponse = Record<string, unknown> & {
  type: string;
  request_id?: string;
  success?: boolean;
  error?: string;
};

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

let client: AppServerClient | null = null;
let connecting = false;
let retryMs = INITIAL_RETRY_MS;
const connectedHooks: (() => void)[] = [];

/** Run `hook` on every (re)connect to the Letta server. */
export function onLettaServerConnected(hook: () => void): void {
  connectedHooks.push(hook);
}

export function isLettaServerReady(): boolean {
  return client !== null;
}

/** Open the connection; it reconnects on its own from then on. */
export function startLettaServerConnection(): void {
  if (client || connecting) return;
  connecting = true;
  const next = new AppServerClient({
    url: config.letta.url,
    authToken: config.letta.token,
    WebSocket: WebSocket as never,
  });
  next.onDisconnect(() => {
    if (client !== next) return;
    client = null;
    console.warn('[letta-server] connection closed; reconnecting');
    scheduleRetry();
  });
  next
    .connect()
    .then(() => {
      connecting = false;
      client = next;
      retryMs = INITIAL_RETRY_MS;
      console.info('[letta-server] connected');
      for (const hook of connectedHooks) hook();
    })
    .catch((error: unknown) => {
      connecting = false;
      console.warn(
        `[letta-server] connect failed: ${error instanceof Error ? error.message : String(error)}`
      );
      scheduleRetry();
    });
}

function scheduleRetry(): void {
  setTimeout(startLettaServerConnection, retryMs);
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
}

/** One request/response round trip; the response is matched by `request_id`. */
export async function lettaServerRequest<T extends ProtocolResponse>(
  command: Record<string, unknown> & { type: string },
  timeoutMs = 30_000
): Promise<T> {
  if (!client) throw new Error('The Letta server is not connected');
  const requestId = `backend-${command.type}-${randomUUID()}`;
  return client.requestRaw<T>(
    { ...command, request_id: requestId },
    {
      timeoutMs,
      predicate: (message): message is T =>
        Boolean(message) &&
        typeof message === 'object' &&
        (message as { request_id?: unknown }).request_id === requestId,
    }
  );
}

/** A file in the Letta container, or null when it does not exist. */
export async function readLettaFile(path: string): Promise<string | null> {
  const response = await lettaServerRequest<ProtocolResponse & { content?: string | null }>({
    type: 'read_file',
    path,
    encoding: 'utf8',
  });
  if (response.success && typeof response.content === 'string') return response.content;
  if (/ENOENT|no such file/i.test(response.error ?? '')) return null;
  throw new Error(response.error ?? `Could not read ${path}`);
}

/** Write a file in the Letta container (parent directories are created). */
export async function writeLettaFile(path: string, content: string): Promise<void> {
  const response = await lettaServerRequest({ type: 'write_file', path, content });
  if (response.success !== true) throw new Error(response.error ?? `Could not write ${path}`);
}
