import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { toCatalogTools } from './mcp-bridge/catalog';
import { type ListedTool, textOfResult } from './mcp-bridge/client';
import type { McpServer } from './mcp/settings';

interface Rpc {
  jsonrpc: '2.0';
  id: string;
  method: 'tools/call';
  params: { name: string; arguments: Record<string, unknown> };
}
interface Device {
  session: string;
  tools: ListedTool[];
  seen: number;
  queue: Rpc[];
  wake?: () => void;
}
export class DeviceHub {
  private devices = new Map<string, Device>();
  private pending = new Map<
    string,
    { session: string; resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  register(name: string, tools: ListedTool[]) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw new Error('Device name must contain 1–64 letters, digits, underscores or hyphens');
    if (
      !Array.isArray(tools) ||
      tools.length > 100 ||
      !tools.every(
        (t) =>
          t &&
          typeof t.name === 'string' &&
          /^[a-zA-Z0-9_-]{1,128}$/.test(t.name) &&
          t.inputSchema?.type === 'object' &&
          (t.description === undefined || typeof t.description === 'string')
      )
    )
      throw new Error('Invalid MCP tools');
    if (new Set(tools.map((t) => t.name)).size !== tools.length)
      throw new Error('Duplicate tool names');
    this.prune();
    if (!this.devices.has(name) && this.devices.size >= 100) throw new Error('Too many devices');
    const previous = this.devices.get(name);
    if (previous) this.remove(name);
    const session = randomUUID();
    this.devices.set(name, { session, tools, seen: Date.now(), queue: [] });
    return session;
  }
  private remove(name: string) {
    const device = this.devices.get(name);
    if (!device) return;
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
              text: 'Device disconnected. Do not retry actions unless the user requests it.',
            },
          ],
        });
      }
  }
  private prune() {
    for (const [name, d] of this.devices) if (Date.now() - d.seen > 75_000) this.remove(name);
  }
  private get(name: string, session: string) {
    this.prune();
    const d = this.devices.get(name);
    if (!d || d.session !== session) throw new Error('Device session expired; register again');
    d.seen = Date.now();
    return d;
  }
  catalog() {
    this.prune();
    return [...this.devices].flatMap(([name, d]) =>
      toCatalogTools({ name: `device_${name}`, transport: 'http', url: `device:${name}` }, d.tools)
    );
  }
  async poll(name: string, session: string, signal: AbortSignal) {
    const d = this.get(name, session);
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
    this.get(name, session);
    if (signal.aborted) return [];
    return d.queue.splice(0);
  }
  result(name: string, session: string, id: string, result: unknown) {
    this.get(name, session);
    const p = this.pending.get(id);
    if (!p || p.session !== session) throw new Error('Unknown or expired tool call');
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(result);
  }
  async call(server: McpServer, tool: string, args: Record<string, unknown>) {
    this.prune();
    const name = server.url?.slice('device:'.length) ?? '';
    const d = this.devices.get(name);
    if (!d || !d.tools.some((t) => t.name === tool)) throw new Error('Device or tool is offline');
    if (this.pending.size >= 100) throw new Error('Too many pending device calls');
    const id = randomUUID();
    const result = new Promise<unknown>((resolve) => {
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
      this.pending.set(id, { session: d.session, resolve, timer });
    });
    d.queue.push({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    });
    d.wake?.();
    return textOfResult(await result);
  }
}
export const deviceHub = new DeviceHub();
export const devices = new Hono();
devices.use('*', bodyLimit({ maxSize: 256_000 }));
devices.post('/register', async (c) => {
  try {
    const body = await c.req.json();
    const session = deviceHub.register(body.name, body.tools);
    return c.json({ session });
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
});
devices.get('/:name/poll', async (c) => {
  try {
    return c.json({
      requests: await deviceHub.poll(
        c.req.param('name'),
        c.req.header('X-Device-Session') ?? '',
        c.req.raw.signal
      ),
    });
  } catch (e) {
    return c.json({ error: String(e) }, 409);
  }
});
devices.post('/:name/results', async (c) => {
  try {
    const body = await c.req.json();
    deviceHub.result(
      c.req.param('name'),
      c.req.header('X-Device-Session') ?? '',
      body.id,
      body.error
        ? { isError: true, content: [{ type: 'text', text: JSON.stringify(body.error) }] }
        : body.result
    );
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e) }, 409);
  }
});
