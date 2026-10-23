import type { ChatMessage, ConversationSummary, McpServer, Modality } from '../chat-types';
import { HttpError } from '../http';
import type {
  AgentServerError,
  ManagedMcpServersRequest,
  WarmRequest,
} from '../../../shared/contracts/agent-server.ts';

interface AgentServerOptions {
  /** Base URL of the agent-server, e.g. `http://agent-server:4000`. */
  url: string;
  /** Bearer token the agent-server requires on its `/v1` routes (`AGENT_SERVER_TOKEN`). */
  token: string;
}

interface MessagePage {
  messages: ChatMessage[];
  nextCursor: string | null;
}

/** Browser request headers the API relies on; cookies and the session stay at the gateway. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'if-match', 'last-event-id', 'x-voice-call-id'];
/** Response headers the API relies on: conditional requests, pagination and caching. */
const FORWARDED_RESPONSE_HEADERS = ['cache-control', 'content-type', 'etag', 'x-next-cursor'];
const INTERNAL_TIMEOUT_MS = 10_000;
/**
 * How long a relayed request may wait for the agent-server's response headers. Streamed bodies are not limited.
 * Shorter than the browser's own patience so the gateway's 502/503 arrives before the browser gives up.
 */
const RELAY_HEADERS_TIMEOUT_MS = 8_000;

/**
 * The gateway's only connection to the agent-server. Browser and voice-agent
 * requests are relayed unchanged (status, headers, streamed bodies); the
 * methods below are the calls the gateway makes on its own behalf.
 */
export class AgentServerClient {
  constructor(private readonly options: AgentServerOptions) {}

  /** Forward a gateway request to `path`, streaming the response back. Client disconnects abort the upstream call. */
  async relay(request: Request, path: string, body?: string): Promise<Response> {
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const upstream = await this.send(request.method, path, {
      body: body ?? (await requestBody(request)),
      headers,
      signal: request.signal,
      headersTimeoutMs: RELAY_HEADERS_TIMEOUT_MS,
    });
    // The browser's session is already valid at the gateway, so an upstream 401 means the gateway's own token is stale.
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      throw new HttpError('Agent server rejected the gateway credentials', 502);
    }
    return new Response(upstream.body, { status: upstream.status, headers: pick(upstream.headers, FORWARDED_RESPONSE_HEADERS) });
  }

  /** A request whose non-2xx answer becomes an HttpError with the agent-server's message. */
  async request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Response> {
    const response = await this.send(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    if (response.ok) return response;
    const detail = (await response.json().catch(() => null)) as Partial<AgentServerError> | null;
    throw new HttpError(
      typeof detail?.error === 'string' ? detail.error : 'Agent server request failed',
      response.status
    );
  }

  async json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return (await this.request(method, path, body, timeoutMs)).json() as Promise<T>;
  }

  conversation(id: string): Promise<ConversationSummary> {
    return this.json<ConversationSummary>('GET', conversationPath(id), undefined, INTERNAL_TIMEOUT_MS);
  }

  async warm(id: string, modality: Modality): Promise<void> {
    await this.request('POST', `${conversationPath(id)}/warm`, { modality } satisfies WarmRequest, INTERNAL_TIMEOUT_MS);
  }

  async messagesPage(id: string, query: { before?: string; limit: number }): Promise<MessagePage> {
    const params = new URLSearchParams({ limit: String(query.limit) });
    if (query.before) params.set('before', query.before);
    const response = await this.request('GET', `${conversationPath(id)}/messages?${params}`);
    return {
      messages: (await response.json()) as ChatMessage[],
      nextCursor: response.headers.get('X-Next-Cursor'),
    };
  }

  /** Replace the device-managed servers the agent-server merges into its MCP list. */
  async setManagedMcp(servers: McpServer[]): Promise<void> {
    await this.request('PUT', '/v1/mcp/managed', { servers } satisfies ManagedMcpServersRequest, INTERNAL_TIMEOUT_MS);
  }

  /** One authenticated request to the agent-server. Unreachable or aborted upstreams surface as 503. */
  async send(
    method: string,
    path: string,
    init: { body?: string; headers?: Headers; signal?: AbortSignal; timeoutMs?: number; headersTimeoutMs?: number } = {}
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.options.token}`);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
    const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    // Bounds only the wait for response headers: the timer is cleared once they arrive, so streamed bodies are not cut off.
    const headersAbort = new AbortController();
    const headersTimer = init.headersTimeoutMs
      ? setTimeout(() => headersAbort.abort(), init.headersTimeoutMs)
      : undefined;
    try {
      return await fetch(`${this.options.url.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        body: init.body,
        signal: AbortSignal.any([...signals, headersAbort.signal]),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new HttpError('Agent server is unavailable', 503);
    } finally {
      clearTimeout(headersTimer);
    }
  }
}

function conversationPath(id: string): string {
  return `/v1/conversations/${encodeURIComponent(id)}`;
}

async function requestBody(request: Request): Promise<string | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const text = await request.text();
  return text === '' ? undefined : text;
}

function pick(source: Headers, names: readonly string[]): Headers {
  const picked = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) picked.set(name, value);
  }
  return picked;
}
