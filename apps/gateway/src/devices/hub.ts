import {
  type CallToolResult,
  CallToolResultSchema,
  type Tool,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../assistant/config';
import { equalSecret } from '../auth';
import type { McpServer } from '../chat-types';

interface Rpc {
  jsonrpc: '2.0';
  id: string;
  method: 'tools/call';
  params: { name: string; arguments: Record<string, unknown> };
}
const MAX_QUEUED_CALLS_PER_DEVICE = 32;
interface Device {
  session: string;
  key: string;
  tools: Tool[];
  seen: number;
  connectedAt: string;
  queue: Rpc[];
  streaming: boolean;
  wake?: () => void;
}

/** Outbound connections only. Every connection is exposed as its own standard MCP server. */
export class DeviceHub {
  private devices = new Map<string, Device>();
  private pending = new Map<
    string,
    {
      session: string;
      tool: string;
      sourcePath?: string;
      uploadStarted?: boolean;
      resolve: (value: CallToolResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private changed: () => Promise<void> = async () => {};
  private expiry: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly options: { baseUrl?: () => string; now?: () => number } = {}) {}
  start() {
    if (this.expiry) return;
    this.expiry = setInterval(() => {
      void this.expire().catch((error) =>
        console.error('[devices] registry cleanup failed', error)
      );
    }, 5_000);
    this.expiry.unref();
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  onChange(listener?: () => Promise<void>) {
    this.changed = listener ?? (async () => {});
  }
  private refreshRegistry(name?: string, session?: string, attempt = 0) {
    if (name && this.devices.get(name)?.session !== session) return;
    void Promise.resolve()
      .then(() => this.changed())
      .catch((error) => {
        console.error('[devices] registry refresh failed', error);
        if (attempt >= 5) return;
        const timer = setTimeout(
          () => this.refreshRegistry(name, session, attempt + 1),
          Math.min(1_000 * 2 ** attempt, 30_000)
        );
        timer.unref();
      });
  }
  close() {
    if (this.expiry) clearInterval(this.expiry);
    this.expiry = undefined;
    for (const name of this.devices.keys()) this.remove(name);
  }

  async register(name: string, tools: unknown): Promise<string> {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw new Error('Device name must contain 1–64 letters, digits, underscores or hyphens');
    const validated = ToolSchema.array().max(100).parse(tools);
    if (!validated.every((t: Tool) => /^[a-zA-Z0-9_-]{1,128}$/.test(t.name)))
      throw new Error('Invalid MCP tool name');
    if (new Set(validated.map((t: Tool) => t.name)).size !== validated.length)
      throw new Error('Duplicate tool names');
    let expired = false;
    for (const [deviceName, device] of this.devices)
      if (this.now() - device.seen > 75_000) expired = this.remove(deviceName) || expired;
    if (expired) this.refreshRegistry();
    if (!this.devices.has(name) && this.devices.size >= 100) throw new Error('Too many devices');
    this.remove(name);
    const session = randomUUID();
    this.devices.set(name, {
      session,
      key: randomBytes(32).toString('base64url'),
      tools: validated,
      seen: this.now(),
      connectedAt: new Date(this.now()).toISOString(),
      queue: [],
      streaming: false,
    });
    // Registration is the device's handshake. Do not make it wait on the
    // agent-server's MCP sync (which can be slow on startup); publish it separately.
    this.refreshRegistry(name, session);
    return session;
  }
  private remove(name: string, session?: string): boolean {
    const device = this.devices.get(name);
    if (!device || (session && session !== device.session)) return false;
    this.devices.delete(name);
    device.wake?.();
    for (const [id, request] of this.pending)
      if (request.session === device.session) {
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.resolve({
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Device disconnected. The outcome of any dispatched action is unknown; do not automatically retry.',
            },
          ],
        });
      }
    return true;
  }
  async unregister(name: string, session: string): Promise<void> {
    if (this.remove(name, session)) await this.changed();
  }
  async expire(): Promise<void> {
    let removed = false;
    for (const [name, d] of this.devices)
      if (this.now() - d.seen > 75_000) removed = this.remove(name) || removed;
    if (removed) await this.changed();
  }
  private get(name: string, session: string, touch = false): Device {
    const d = this.devices.get(name);
    if (!d || d.session !== session || this.now() - d.seen > 75_000)
      throw new Error('Device session expired; register again');
    if (touch) d.seen = this.now();
    return d;
  }
  heartbeat(name: string, session: string) {
    this.get(name, session, true);
  }
  openStream(name: string, session: string) {
    const d = this.get(name, session, true);
    if (d.streaming) throw new Error('Device already has an active connection');
    d.streaming = true;
  }
  servers(): McpServer[] {
    const base = (
      this.options.baseUrl?.() ??
      process.env.MCP_DEVICE_BASE_URL ??
      `http://127.0.0.1:${config.port}`
    ).replace(/\/$/, '');
    return [...this.devices]
      .filter(([, d]) => this.now() - d.seen <= 75_000)
      .map(([name, d]) => ({
        name: `device_${name}`,
        transport: 'http',
        url: `${base}/internal/mcp/devices/${encodeURIComponent(name)}`,
        headers: { Authorization: `Bearer ${d.key}` },
        managed: {
          type: 'device',
          deviceName: name,
          connectedAt: d.connectedAt,
          tools: d.tools.length,
        },
      }));
  }
  authenticate(name: string, header: string): string | null {
    const d = this.devices.get(name);
    return d && this.now() - d.seen <= 75_000 && equalSecret(header, `Bearer ${d.key}`)
      ? d.session
      : null;
  }
  tools(name: string, session: string): Tool[] {
    return this.get(name, session).tools;
  }
  async poll(name: string, session: string, signal: AbortSignal, touch = true): Promise<Rpc[]> {
    const d = this.get(name, session, touch);
    if (d.wake) throw new Error('A poll is already active');
    if (!d.queue.length && !signal.aborted)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          d.wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, 25_000);
        d.wake = done;
        signal.addEventListener('abort', done, { once: true });
      });
    this.get(name, session, touch);
    return signal.aborted ? [] : d.queue.splice(0);
  }
  result(name: string, session: string, id: string, result: unknown) {
    this.get(name, session, true);
    const p = this.pending.get(id);
    if (!p || p.session !== session) throw new Error('Unknown or expired tool call');
    const validated = CallToolResultSchema.parse(result);
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(validated);
  }
  beginFileUpload(name: string, session: string, id: string): string {
    this.checkFileUpload(name, session, id);
    const p = this.pending.get(id)!;
    if (p.uploadStarted) throw new Error('File upload already started');
    p.uploadStarted = true;
    return p.sourcePath!;
  }
  checkFileUpload(name: string, session: string, id: string) {
    this.get(name, session, true);
    const p = this.pending.get(id);
    if (!p || p.session !== session || p.tool !== 'filesystem_export' || !p.sourcePath)
      throw new Error('No matching pending file export');
  }
  async call(
    name: string,
    session: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const d = this.get(name, session);
    if (!d.tools.some((t) => t.name === tool)) throw new Error('Unknown device tool');
    if (d.queue.length >= MAX_QUEUED_CALLS_PER_DEVICE)
      throw new Error('Device request queue is full');
    if (this.pending.size >= 100) throw new Error('Too many pending device calls');
    const id = randomUUID();
    const result = new Promise<CallToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        d.queue = d.queue.filter((r) => r.id !== id);
        resolve({
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Device call timed out; its outcome is unknown. Do not automatically retry.',
            },
          ],
        });
      }, 60_000);
      this.pending.set(id, {
        session: d.session,
        tool,
        sourcePath: typeof args.path === 'string' ? args.path : undefined,
        resolve,
        timer,
      });
    });
    d.queue.push({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    });
    d.wake?.();
    return result;
  }
}
export const deviceHub = new DeviceHub();
