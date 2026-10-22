import {
  BotIcon,
  BrainIcon,
  CircleStopIcon,
  EyeIcon,
  FolderOpenIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  ListIcon,
  type LucideIcon,
  PenLineIcon,
  PhoneIcon,
  PhoneOffIcon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import type { ToolDisplay, ToolTaskRef } from '@shared/chat-types';
import { stripLeadingEmoji } from '../../../lib/agent-runs.ts';
import { TOOL_NAMES } from '../../../lib/tool-names.ts';

/**
 * How tool calls look in the thread: the one place that knows tools. A call
 * shows the first presentation that matches it, or the default one. Calls are
 * matched by the agent-server's tool names, and labelled from the structured
 * `display` and `task` the server sends with them.
 */

/** What the server sent with a call: its display, and the background task it started or moved. */
export type ToolCallUi = { display?: ToolDisplay; task?: ToolTaskRef };

/** A tool call, as presentations match and describe it. */
export type ToolCall = {
  toolName: string;
  /** The raw arguments, possibly still streaming. */
  argsText: string | undefined;
  args: Record<string, unknown>;
  ui: ToolCallUi;
};

/** A titled card in a call's details. */
export type ToolCard = { title: string; content: unknown };

export type ToolPresentation = {
  /** Whether this presentation presents the call. */
  match: (call: ToolCall) => boolean;
  icon: LucideIcon;
  hideIcon?: boolean;
  /** Trigger label for a single call, or undefined to keep the default label. */
  describe: (call: ToolCall) => string | undefined;
  /**
   * Group trigger label when every call in the group shows this presentation, from
   * the calls the label is about (see `getToolGroupLabel`): one or more.
   */
  groupLabel: (calls: ToolCall[]) => string;
  /** The cards a call's arguments show in its details, ahead of its result. */
  cards: (call: ToolCall) => ToolCard[];
};

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** "1 page", "3 pages". */
const counted = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;

/** A text as one line, cut to `max` characters for a label. */
const excerpt = (text: string, max = 60) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The file a call works on, by its name. */
const fileName = (args: Record<string, unknown>) => {
  const path = nonEmptyString(args.path) ?? nonEmptyString(args.file_path);
  return path ? basename(path) : undefined;
};

/** One card per argument, or the raw arguments while they are not a JSON object. */
function argumentCards({ argsText }: ToolCall): ToolCard[] {
  if (!argsText) return [];
  try {
    const parsed: unknown = JSON.parse(argsText);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.entries(parsed).map(([title, content]) => ({ title, content }))
      : [{ title: 'Arguments', content: parsed }];
  } catch {
    // Incomplete streamed JSON stays readable until it can be parsed.
    return [{ title: 'Arguments', content: argsText }];
  }
}

/** The bridge tools that run an MCP tool: `{ tool, arguments }`. */
const BRIDGE_CALLS: readonly string[] = [TOOL_NAMES.mcpCall, TOOL_NAMES.mcpCallWrite];

/**
 * The MCP tool a bridge call runs (`mcp__<server>__<tool>`, or a bare name) and
 * the JSON of its arguments; undefined for other calls.
 */
function mcpToolCall(call: ToolCall): { tool: string; argsText: string | undefined } | undefined {
  if (!BRIDGE_CALLS.includes(call.toolName)) return undefined;
  const tool = nonEmptyString(call.args.tool)?.trim();
  const args = call.args.arguments;
  if (!tool) return undefined;
  return { tool, argsText: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
}

/**
 * Matches calls of an MCP tool by its own name, whatever the server is called
 * in Settings: `web_search_exa` matches `mcp__<server>__web_search_exa`.
 */
const mcpTool =
  (...names: (string | RegExp)[]) =>
  (call: ToolCall) => {
    const tool = mcpToolCall(call)?.tool;
    return (
      tool !== undefined &&
      names.some((name) =>
        typeof name === 'string'
          ? tool === name || tool.endsWith(`__${name}`)
          : name.test(tool.replace(/^mcp__.+?__/, ''))
      )
    );
  };

const isWebSearch = mcpTool('web_search_exa');
const isWebFetch = mcpTool('web_fetch_exa');
/** Exa's research agent: `agent_run` and its siblings. */
const isDeepResearch = mcpTool(/^agent_/);

/** The query of a web search (empty until it can be read), or undefined for other calls. */
export function webSearchQuery(call: ToolCall): string | undefined {
  if (!isWebSearch(call)) return undefined;
  try {
    const args: unknown = JSON.parse(mcpToolCall(call)?.argsText ?? '');
    const query = (args as { query?: unknown } | null)?.query;
    return typeof query === 'string' ? query : '';
  } catch {
    return '';
  }
}

/** An MCP tool call shows the tool's arguments, any other call its own. */
function mcpCards(call: ToolCall): ToolCard[] {
  const mcp = mcpToolCall(call);
  return argumentCards(mcp ? { ...call, argsText: mcp.argsText } : call);
}

/** `mcp__<server>__<tool>` as "<tool> (<server>)"; a bare tool name as is. */
function mcpToolLabel(value: unknown): string | undefined {
  const name = nonEmptyString(value)?.trim();
  const match = name && /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[2]} (${match[1]})` : name;
}

/** The command display of a shell call, when the server sent one. */
function commandDisplay(call: ToolCall) {
  return call.ui.display?.type === 'command' ? call.ui.display : undefined;
}

/** A worker call that resumes an earlier task (a follow-up), not a fresh one. */
function isWorkerRestart(call: ToolCall): boolean {
  return (
    (call.ui.display?.type === 'agent' && Boolean(call.ui.display.resumedFromTaskId)) ||
    nonEmptyString(call.args.resume_task_id) !== undefined
  );
}

/** The trigger label of a worker call: its launch, or its follow-up. */
function workerLabel(call: ToolCall, agentTitle?: string): string {
  const description = nonEmptyString(call.args.description);
  if (isWorkerRestart(call)) {
    const followup = stripLeadingEmoji(description ?? '') || 'Follow-up';
    return `${agentTitle ?? 'Agent'} - Agent restarted: ${followup}`;
  }
  return `${agentTitle ?? description ?? 'Agent'} - Agent started`;
}

/** A presentation for the calls of these tools, unless `match` narrows them (by arguments, say). */
function toolDisplay(
  toolNames: string | readonly string[],
  display: Omit<ToolPresentation, 'match' | 'cards'> &
    Partial<Pick<ToolPresentation, 'match' | 'cards'>>
): ToolPresentation {
  const names = [toolNames].flat();
  return {
    ...display,
    match: display.match ?? ((call) => names.includes(call.toolName)),
    cards: display.cards ?? argumentCards,
  };
}

const TOOL_DISPLAYS: ToolPresentation[] = [
  // Exa's tools, through the MCP bridge, ahead of the generic presentations.
  // Searches and fetches share one presentation, so a mix of them groups as pages.
  toolDisplay(BRIDGE_CALLS, {
    match: (call) => isWebSearch(call) || isWebFetch(call),
    icon: GlobeIcon,
    describe: (call) => (isWebFetch(call) ? 'Visited web page' : 'Searched the web'),
    groupLabel: (calls) => {
      const visits = calls.filter(isWebFetch).length;
      return visits > 0
        ? `Searched online · visited ${counted(visits, 'page')}`
        : 'Searched online';
    },
    cards: mcpCards,
  }),
  toolDisplay(BRIDGE_CALLS, {
    match: isDeepResearch,
    icon: BotIcon,
    describe: () => 'Deep research',
    groupLabel: (calls) => `Launched ${counted(calls.length, 'deep research task')}`,
    cards: mcpCards,
  }),
  toolDisplay(TOOL_NAMES.bash, {
    icon: TerminalIcon,
    describe: (call) => nonEmptyString(commandDisplay(call)?.description ?? call.args.description),
    groupLabel: (calls) => `Ran ${counted(calls.length, 'command')}`,
  }),
  toolDisplay(TOOL_NAMES.readFile, {
    icon: EyeIcon,
    describe: ({ args }) => {
      const name = fileName(args);
      return name ? `Opened ${name}` : undefined;
    },
    groupLabel: (calls) => `Opened ${counted(calls.length, 'file')}`,
  }),
  toolDisplay(TOOL_NAMES.editFile, {
    icon: PenLineIcon,
    describe: ({ args }) => {
      const name = fileName(args);
      return name ? `Edited ${name}` : undefined;
    },
    groupLabel: (calls) => `Made ${counted(calls.length, 'edit')}`,
  }),
  toolDisplay(TOOL_NAMES.writeFile, {
    icon: PenLineIcon,
    describe: ({ args }) => {
      const name = fileName(args);
      return name ? `Wrote ${name}` : undefined;
    },
    groupLabel: (calls) => `Wrote ${counted(calls.length, 'file')}`,
  }),
  toolDisplay(TOOL_NAMES.deleteFile, {
    icon: Trash2Icon,
    describe: ({ args }) => {
      const name = fileName(args);
      return name ? `Deleted ${name}` : undefined;
    },
    groupLabel: (calls) => `Deleted ${counted(calls.length, 'file')}`,
  }),
  toolDisplay(TOOL_NAMES.listFiles, {
    icon: FolderOpenIcon,
    describe: ({ args }) => {
      const path = nonEmptyString(args.path);
      return path ? `Listed ${basename(path)}` : 'Listed files';
    },
    groupLabel: (calls) => `Listed ${counted(calls.length, 'folder')}`,
  }),
  toolDisplay(TOOL_NAMES.searchFiles, {
    icon: SearchIcon,
    describe: ({ args }) => {
      const pattern = nonEmptyString(args.pattern) ?? nonEmptyString(args.query);
      return pattern ? `Searched files for ${pattern}` : 'Searched files';
    },
    groupLabel: (calls) => `Ran ${counted(calls.length, 'file search')}`,
  }),
  // Memory: searched for what the agent knows, or remembered something new.
  toolDisplay(TOOL_NAMES.memorySearch, {
    icon: SearchIcon,
    describe: ({ args }) => {
      const query = nonEmptyString(args.query);
      return query ? `Searching memory: ${excerpt(query)}` : 'Searching memory';
    },
    groupLabel: (calls) =>
      calls.length === 1 ? 'Ran 1 memory search' : `Ran ${calls.length} memory searches`,
  }),
  toolDisplay(TOOL_NAMES.memoryRemember, {
    icon: BrainIcon,
    describe: ({ args }) => {
      const content = nonEmptyString(args.content);
      return content ? `Remembering: ${excerpt(content)}` : 'Remembering';
    },
    groupLabel: (calls) =>
      calls.length === 1 ? 'Saved 1 memory' : `Saved ${calls.length} memories`,
  }),
  // Workers: `run_agent` starts one, or resumes one with `resume_task_id`.
  toolDisplay(TOOL_NAMES.runAgent, {
    icon: BotIcon,
    hideIcon: true,
    describe: (call) => workerLabel(call),
    groupLabel: (calls) => `Started ${counted(calls.length, 'agent')}`,
  }),
  toolDisplay(TOOL_NAMES.listTasks, {
    icon: ListIcon,
    describe: () => 'Listed tasks',
    groupLabel: (calls) => `Listed ${counted(calls.length, 'task list')}`,
  }),
  toolDisplay(TOOL_NAMES.getTask, {
    icon: ListIcon,
    describe: () => 'Checked a task',
    groupLabel: (calls) => `Checked ${counted(calls.length, 'task')}`,
  }),
  toolDisplay(TOOL_NAMES.stopTask, {
    icon: CircleStopIcon,
    describe: () => 'Stopped a task',
    groupLabel: (calls) => `Stopped ${counted(calls.length, 'task')}`,
  }),
  // The MCP bridge: describe a server's tool, then call it.
  toolDisplay([TOOL_NAMES.mcpDescribe, ...BRIDGE_CALLS], {
    icon: PlugIcon,
    describe: ({ toolName, args }) => {
      const tool = mcpToolLabel(args.tool);
      if (!tool) return undefined;
      return toolName === TOOL_NAMES.mcpDescribe ? `Read about ${tool}` : `Used ${tool}`;
    },
    groupLabel: (calls) => `Made ${counted(calls.length, 'MCP call')}`,
    cards: mcpCards,
  }),
  // Calls: changing the mode of the voice call, and ending it.
  toolDisplay(TOOL_NAMES.setCallMode, {
    icon: PhoneIcon,
    describe: ({ args }) => {
      const mode = nonEmptyString(args.mode);
      return mode ? `Set call mode to ${mode}` : 'Changed the call mode';
    },
    groupLabel: (calls) => `Changed ${counted(calls.length, 'call mode')}`,
  }),
  toolDisplay(TOOL_NAMES.endCall, {
    icon: PhoneOffIcon,
    describe: () => 'Ended the call',
    groupLabel: (calls) => `Ended ${counted(calls.length, 'call')}`,
  }),
  // Generative UI: shown as a call only while it runs or when it failed.
  toolDisplay(TOOL_NAMES.present, {
    icon: LayoutDashboardIcon,
    describe: () => 'Interactive view',
    groupLabel: (calls) => `Showed ${counted(calls.length, 'view')}`,
  }),
];

const defaultLabel = ({ toolName }: ToolCall) => toolName;

/** Any other tool call, and groups of calls that show different presentations. */
const DEFAULT_TOOL_DISPLAY: ToolPresentation = {
  match: () => true,
  icon: WrenchIcon,
  describe: defaultLabel,
  groupLabel: (calls) => `Used ${counted(calls.length, 'tool')}`,
  cards: argumentCards,
};

/** The UI data of a tool-call part, which the thread keeps in the part's `artifact`. */
export function toolCallUi(artifact: unknown): ToolCallUi {
  if (!artifact || typeof artifact !== 'object') return {};
  const { display, task } = artifact as ToolCallUi;
  return { display: display ?? undefined, task: task ?? undefined };
}

export function toolCall(
  toolName: string,
  argsText: string | undefined,
  ui: ToolCallUi = {}
): ToolCall {
  return { toolName, argsText, args: parseToolArgs(argsText), ui };
}

export function getToolDisplay(call: ToolCall): ToolPresentation {
  return TOOL_DISPLAYS.find((display) => display.match(call)) ?? DEFAULT_TOOL_DISPLAY;
}

/**
 * Calls that only prepare the next ones (reading about MCP tools): a group's
 * label is about what those next calls did, so these do not count, and
 * "describe, three web searches" reads as three web searches.
 */
const PREPARATORY_TOOLS = new Set<string>([TOOL_NAMES.mcpDescribe]);

/** The calls a group's label is about: all of them when every one only prepares. */
function labelledCalls(calls: ToolCall[]): ToolCall[] {
  const doing = calls.filter((call) => !PREPARATORY_TOOLS.has(call.toolName));
  return doing.length > 0 ? doing : calls;
}

/** The presentation of a group: the one its calls share, or the default. */
export function getToolGroupDisplay(calls: ToolCall[]): ToolPresentation {
  const [first, ...rest] = labelledCalls(calls).map(getToolDisplay);
  return first && rest.every((display) => display === first) ? first : DEFAULT_TOOL_DISPLAY;
}

/** A group's trigger label, from the calls its presentation is about. */
export function getToolGroupLabel(calls: ToolCall[]): string {
  return getToolGroupDisplay(calls).groupLabel(labelledCalls(calls));
}

/** The trigger label of a single call. */
export function toolCallLabel(call: ToolCall, agentTitle?: string, background = false): string {
  const label =
    call.toolName === TOOL_NAMES.runAgent
      ? workerLabel(call, agentTitle)
      : (getToolDisplay(call).describe(call) ?? defaultLabel(call));
  return background && call.toolName === TOOL_NAMES.bash ? `(background) ${label}` : label;
}

/**
 * Whether a shell call runs in the background: it started a background task,
 * or its display says so. `tracked` is set when the activity already knows the
 * call's task to be a command.
 */
export function commandIsBackground(call: ToolCall, tracked = false): boolean {
  if (call.toolName !== TOOL_NAMES.bash) return false;
  if (tracked || call.ui.task?.kind === 'command') return true;
  const display = commandDisplay(call);
  if (display) return Boolean(display.background);
  return call.args.run_in_background === true;
}

function parseToolArgs(argsText: string | undefined): Record<string, unknown> {
  if (!argsText) return {};
  try {
    const args: unknown = JSON.parse(argsText);
    return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  } catch {
    // Arguments may still be streaming, or not JSON at all.
    return {};
  }
}
