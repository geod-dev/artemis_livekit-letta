import { useCallback, useEffect, useState } from 'react';
import { PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import type { McpServer, McpSettingsResponse, McpTransport } from '@shared/chat-types';
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
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return body?.error ?? fallback;
}

/**
 * One MCP server list shared by every agent. The agent-server keeps the list and
 * tells agents about changes on their next turn, through the `mcp_*` tools.
 * Reads and writes go through /api/mcp.
 */
export function McpServers({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<McpSettingsResponse | null>(null);
  const [status, setStatus] = useState('');
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
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

  const persist = async (next: McpServer[], revision: string | null): Promise<boolean> => {
    if (!revision) {
      setStatus('Reload settings before saving.');
      return false;
    }
    setStatus('Saving and connecting…');
    try {
      const response = await fetch('/api/mcp', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${revision}"`,
        },
        body: JSON.stringify({
          servers: next.filter((server) => !server.managed),
        }),
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
    setDraftRevision(settings?.revision ?? null);
  };

  const commit = async () => {
    if (!draft?.name.trim()) return;
    const next = [...editableServers];
    try {
      if (draftIndex === null) next.push(fromDraft(draft));
      else next[draftIndex] = fromDraft(draft);
      if (await persist(next, draftRevision)) setDraft(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (index: number) => {
    setRemoving(null);
    await persist(
      editableServers.filter((_, i) => i !== index),
      settings?.revision ?? null
    );
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

      {settings?.diagnostics.map((entry) => (
        <p
          key={`invalid-${entry.index}`}
          className="text-destructive rounded-md border px-3 py-2 text-sm"
        >
          Invalid saved MCP entry {entry.index + 1}: {entry.diagnostic}. It is excluded from tools
          and preserved when saving.
        </p>
      ))}

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
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setRemoving(index)}
                    aria-label={`Remove ${server.name}`}
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
                onChange({
                  ...draft,
                  transport: event.target.value as McpTransport,
                })
              }
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              <option value="http">http (Streamable HTTP)</option>
              <option value="sse">sse (legacy)</option>
              <option value="stdio">stdio (a command in the agent-server container)</option>
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
                <Textarea
                  value={draft.args}
                  placeholder={'["-y", "@modelcontextprotocol/server-everything"]'}
                  onChange={(event) => onChange({ ...draft, args: event.target.value })}
                  className="min-h-24 font-mono text-xs"
                />
                <span className={FIELD_HINT}>
                  Enter a JSON array of strings to preserve spaces and quotes.
                </span>
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
