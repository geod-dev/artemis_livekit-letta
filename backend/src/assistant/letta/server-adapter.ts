import {
  AppServerClient,
  type AppServerSocketConstructor,
} from '@letta-ai/letta-code/app-server-client';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { config } from '../config';

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
const appServerSocket: AppServerSocketConstructor = WebSocket;

let client: AppServerClient | null = null;
let connecting = false;
let retryMs = INITIAL_RETRY_MS;
const connectedHooks: (() => void)[] = [];
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

/** Run `hook` on every (re)connect to the Letta server. */
export function onLettaServerConnected(hook: () => void): void {
  connectedHooks.push(hook);
}

export function removeLettaServerConnectedHook(hook: () => void): void {
  const index = connectedHooks.indexOf(hook);
  if (index >= 0) connectedHooks.splice(index, 1);
}

export function isLettaServerReady(): boolean {
  return client !== null;
}

/** Open the connection; it reconnects on its own from then on. */
export function startLettaServerConnection(): void {
  if (client || connecting) return;
  connecting = true;
  const currentGeneration = generation;
  const next = new AppServerClient({
    url: config.letta.url,
    authToken: config.letta.token,
    WebSocket: appServerSocket,
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
      if (currentGeneration !== generation) {
        disposeClient(next);
        return;
      }
      connecting = false;
      client = next;
      retryMs = INITIAL_RETRY_MS;
      console.info('[letta-server] connected');
      for (const hook of connectedHooks) hook();
    })
    .catch((error: unknown) => {
      if (currentGeneration !== generation) return;
      connecting = false;
      console.warn(
        `[letta-server] connect failed: ${error instanceof Error ? error.message : String(error)}`
      );
      scheduleRetry();
    });
}

function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    startLettaServerConnection();
  }, retryMs).unref();
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
}

/** Stop reconnect ownership and clear hooks during application shutdown. */
export function closeLettaServerConnection(): void {
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (client) disposeClient(client);
  client = null;
  connecting = false;
  connectedHooks.length = 0;
}

function disposeClient(target: AppServerClient): void {
  try {
    target.close();
  } catch {
    // The transport may already have closed itself.
  }
}

/** One request/response round trip; the response is matched by `request_id`. */
export async function lettaServerRequest(
  command: Record<string, unknown> & { type: string },
  timeoutMs = 30_000
): Promise<ProtocolResponse> {
  if (!client) throw new Error('The Letta server is not connected');
  const requestId = `backend-${command.type}-${randomUUID()}`;
  return client.requestRaw<ProtocolResponse>(
    { ...command, request_id: requestId },
    {
      timeoutMs,
      predicate: (message): message is ProtocolResponse =>
        isAppServerResponseFrame(message) && message.request_id === requestId,
    }
  );
}

/** A file in the Letta container, or null when it does not exist. */
export async function readLettaFile(path: string): Promise<string | null> {
  const response = await lettaServerRequest({
    type: 'read_file',
    path,
    encoding: 'utf8',
  });
  if (response.success === true && typeof response.content === 'string') return response.content;
  if (/ENOENT|no such file/i.test(response.error ?? '')) return null;
  throw new Error(response.error ?? `Could not read ${path}`);
}

export function isAppServerResponseFrame(value: unknown): value is ProtocolResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === 'string' &&
    typeof (value as Record<string, unknown>).request_id === 'string'
  );
}

/** Write a file in the Letta container (parent directories are created). */
export async function writeLettaFile(path: string, content: string): Promise<void> {
  const response = await lettaServerRequest({ type: 'write_file', path, content });
  if (response.success !== true) throw new Error(response.error ?? `Could not write ${path}`);
}
