import { useCallback, useEffect, useState } from 'react';
import { PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import type { McpServer, McpSettingsResponse, McpTransport } from '@backend/chat-types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  BLANK_DRAFT,
  type McpServerDraft,
  describeServer,
  fromDraft,
  isRemote,
  toDraft,
} from '@/lib/mcp-servers';

const FIELD_LABEL = 'flex flex-col gap-1.5 text-sm font-medium';
const FIELD_HINT = 'text-muted-foreground text-xs font-normal';

async function errorText(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/**
 * One MCP server list shared by every agent. Letta keeps MCP servers per agent
 * and overwrites edits made from outside, so the backend keeps this list in a
 * file of its own and tells agents about it through the `mcp-servers` skill and
 * the native `mcp_*` tools (backend/src/mcp/). Reads and writes go through
 * /api/mcp.
 */
export function McpServers({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<McpSettingsResponse | null>(null);
  const [status, setStatus] = useState('');
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const servers = settings?.servers ?? [];
  const editableServers = servers.filter((server) => !server.managed);

  const load = useCallback(async (silent = false) => {
    if (!silent) setStatus('Loading…');
    try {
      const response = await fetch('/api/mcp');
      if (!response.ok) {
        setStatus(await errorText(response, 'Could not read the MCP servers'));
        return;
      }
      setSettings((await response.json()) as McpSettingsResponse);
      if (!silent) setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => {
      void load(true);
    }, 5_000);
    return () => clearInterval(timer);
  }, [active, load]);

  const persist = async (next: McpServer[]): Promise<boolean> => {
    setStatus('Saving and connecting…');
    try {
      const response = await fetch('/api/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: next.filter((server) => !server.managed) }),
      });
      if (!response.ok) {
        setStatus(await errorText(response, 'Save failed'));
        return false;
      }
      setSettings((await response.json()) as McpSettingsResponse);
      setStatus('Saved. Agents see the change on their next turn.');
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const openEditor = (server: McpServer | null, index: number | null) => {
    setDraft(server ? toDraft(server) : { ...BLANK_DRAFT });
    setDraftIndex(index);
  };

  const commit = async () => {
    if (!draft?.name.trim()) return;
    const next = [...editableServers];
    if (draftIndex === null) next.push(fromDraft(draft));
    else next[draftIndex] = fromDraft(draft);
    if (await persist(next)) setDraft(null);
  };

  const remove = async (index: number) => {
    setRemoving(null);
    await persist(editableServers.filter((_, i) => i !== index));
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-extrabold">MCP servers</h2>
        <span className="text-muted-foreground ms-auto text-sm">
          {servers.length} {servers.length === 1 ? 'server' : 'servers'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void load()}
          aria-label="Reload MCP servers"
          title="Reload MCP servers"
        >
          <RefreshCwIcon />
        </Button>
        <Button type="button" size="sm" onClick={() => openEditor(null, null)}>
          <PlusIcon /> Add server
        </Button>
      </div>

      <p className="text-muted-foreground text-sm">
        Connect services and devices so your assistant can use their tools. Devices appear
        automatically while connected and are managed by their connections.
      </p>

      {status && <p className="text-muted-foreground text-sm">{status}</p>}

      <ul className="flex flex-col gap-2">
        {servers.map((server) => {
          const index = editableServers.findIndex((entry) => entry.name === server.name);
          return (
            <li
              key={server.name}
              className="border-border/70 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3"
            >
              <div className="min-w-0 flex-1 basis-36">
                <p className="font-semibold break-words">
                  {server.managed?.deviceName ?? server.name}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {server.managed
                    ? `External device · ${server.managed.tools} ${server.managed.tools === 1 ? 'tool' : 'tools'} · Managed automatically`
                    : describeServer(server)}
                </p>
                <ServerStatus server={server} bridge={settings?.bridge} />
              </div>
              {server.managed ? (
                <span className="bg-mint/10 text-mint rounded-full px-2.5 py-1 text-xs font-medium">
                  Device
                </span>
              ) : removing === index ? (
                <>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void remove(index)}
                  >
                    Remove
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                    Keep
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openEditor(server, index)}
                    aria-label={`Edit ${server.name}`}
                    title="Edit"
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setRemoving(index)}
                    aria-label={`Remove ${server.name}`}
                    title="Remove"
                  >
                    <Trash2Icon />
                  </Button>
                </>
              )}
            </li>
          );
        })}
        {settings && servers.length === 0 && (
          <li className="text-muted-foreground text-sm">No MCP servers configured.</li>
        )}
      </ul>

      <div className="text-muted-foreground text-sm">
        <p className="mb-1.5">Example: a web search server with an API key</p>
        <pre className="bg-muted/50 overflow-x-auto rounded-xl p-3 font-mono text-xs">{`name: search
transport: http
url: https://mcp.example.com/mcp
header: Authorization: Bearer <API key>`}</pre>
      </div>

      {draft && (
        <ServerDialog
          draft={draft}
          adding={draftIndex === null}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void commit()}
          status={status}
        />
      )}
    </div>
  );
}

function ServerStatus({
  server,
  bridge,
}: {
  server: McpServer;
  bridge: McpSettingsResponse['bridge'] | undefined;
}) {
  if (!bridge) return null;
  if (!isRemote(server.transport)) {
    return <p className="text-muted-foreground mt-1 text-xs">Workers only, through the skill</p>;
  }
  const failure = bridge.failures[server.name];
  if (failure) {
    return (
      <p className="text-destructive mt-1 truncate text-xs" title={failure}>
        Not reachable: {failure}
      </p>
    );
  }
  if (bridge.servers.includes(server.name)) {
    return <p className="text-mint mt-1 text-xs">Connected</p>;
  }
  return <p className="text-muted-foreground mt-1 text-xs">No tools listed</p>;
}

function ServerDialog({
  draft,
  adding,
  onChange,
  onCancel,
  onSave,
  status,
}: {
  draft: McpServerDraft;
  adding: boolean;
  onChange: (draft: McpServerDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  status: string;
}) {
  const remote = isRemote(draft.transport);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle>{adding ? 'Add MCP server' : `Edit ${draft.name}`}</DialogTitle>
          <DialogDescription>
            Its tools are named <code>mcp__{draft.name.trim() || '<name>'}__&lt;tool&gt;</code>.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <label className={FIELD_LABEL}>
            Name
            <Input
              autoFocus
              value={draft.name}
              placeholder="search"
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
            />
            <span className={FIELD_HINT}>Letters, digits, “-” and “_”.</span>
          </label>

          <label className={FIELD_LABEL}>
            Transport
            <select
              value={draft.transport}
              onChange={(event) =>
                onChange({ ...draft, transport: event.target.value as McpTransport })
              }
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              <option value="http">http (Streamable HTTP)</option>
              <option value="sse">sse (legacy)</option>
              <option value="stdio">stdio (a command in the Letta container)</option>
            </select>
          </label>

          {remote ? (
            <>
              <label className={FIELD_LABEL}>
                URL
                <Input
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => onChange({ ...draft, url: event.target.value })}
                />
              </label>
              <label className={FIELD_LABEL}>
                Headers
                <Textarea
                  value={draft.headers}
                  placeholder="Authorization: Bearer …"
                  onChange={(event) => onChange({ ...draft, headers: event.target.value })}
                  className="min-h-16 font-mono text-xs"
                />
                <span className={FIELD_HINT}>One “Name: value” per line.</span>
              </label>
            </>
          ) : (
            <>
              <label className={FIELD_LABEL}>
                Command
                <Input
                  value={draft.command}
                  placeholder="npx"
                  onChange={(event) => onChange({ ...draft, command: event.target.value })}
                />
              </label>
              <label className={FIELD_LABEL}>
                Arguments
                <Input
                  value={draft.args}
                  placeholder="-y @modelcontextprotocol/server-everything"
                  onChange={(event) => onChange({ ...draft, args: event.target.value })}
                />
                <span className={FIELD_HINT}>Space separated.</span>
              </label>
              <label className={FIELD_LABEL}>
                Environment
                <Textarea
                  value={draft.env}
                  placeholder="API_KEY=…"
                  onChange={(event) => onChange({ ...draft, env: event.target.value })}
                  className="min-h-16 font-mono text-xs"
                />
                <span className={FIELD_HINT}>One “KEY=value” per line.</span>
              </label>
            </>
          )}

          {status && <p className="text-muted-foreground text-sm">{status}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!draft.name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
