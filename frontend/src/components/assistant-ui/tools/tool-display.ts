import {
  BotIcon,
  CircleStopIcon,
  EyeIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PenLineIcon,
  PlugIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react';

/**
 * How tool calls look in the thread: the one place that knows tools. A call
 * shows the first display that matches it, or the default display.
 */

/** A tool call, as displays match and describe it. */
export type ToolCall = {
  toolName: string;
  /** The raw arguments, possibly still streaming. */
  argsText: string | undefined;
  args: Record<string, unknown>;
};

/** A titled card in a call's details. */
export type ToolCard = { title: string; content: unknown };

export type ToolDisplay = {
  /** Whether this display presents the call. */
  match: (call: ToolCall) => boolean;
  icon: LucideIcon;
  /** Trigger label for a single call, or undefined to keep the default label. */
  describe: (call: ToolCall) => string | undefined;
  /**
   * Group trigger label when every call in the group shows this display, from
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

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The file a call works on, by its name. */
const fileName = (args: Record<string, unknown>) => {
  const path = nonEmptyString(args.file_path) ?? nonEmptyString(args.path);
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

/**
 * An MCP tool call from Bash: `letta mcp call <tool>` (older chats), or the
 * `mcp-servers` skill's wrapper, `sh …/mcp.sh call <tool>`.
 */
const BASH_MCP_CALL = /^(?:letta mcp|sh \S*\/mcp\.sh) call (\S+)/;

/** The bridge tools that run an MCP tool: `{ tool, arguments }`. */
const BRIDGE_CALLS = ['mcp_call', 'mcp_call_write'];

/** The JSON of `… call <tool> --args '<json>'`, unquoted as the shell would. */
function lettaMcpArgs(command: string): string | undefined {
  const value = /--args(?:=|\s+)('(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*"|\S+)/.exec(command)?.[1];
  if (value?.startsWith("'")) return value.slice(1, -1).replaceAll("'\\''", "'");
  if (value?.startsWith('"')) return value.slice(1, -1).replace(/\\([\\"$`])/g, '$1');
  return value;
}

/**
 * The MCP tool a call runs (`mcp__<server>__<tool>`, or a bare name through
 * the bridge) and the JSON of its arguments, through the bridge or from Bash;
 * undefined for other calls.
 */
function mcpToolCall(call: ToolCall): { tool: string; argsText: string | undefined } | undefined {
  if (BRIDGE_CALLS.includes(call.toolName)) {
    const tool = nonEmptyString(call.args.tool)?.trim();
    const args = call.args.arguments;
    if (!tool) return undefined;
    return { tool, argsText: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
  }
  if (call.toolName !== 'Bash') return undefined;
  const command = nonEmptyString(call.args.command)?.trim();
  const match = command && BASH_MCP_CALL.exec(command);
  return match ? { tool: match[1], argsText: lettaMcpArgs(command) } : undefined;
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

/** The shell command of a `Bash` call, unless it is an MCP tool call. */
export function shellCommand(call: ToolCall): string | undefined {
  if (call.toolName !== 'Bash') return undefined;
  const command = nonEmptyString(call.args.command)?.trim();
  return command && BASH_MCP_CALL.test(command) ? undefined : command;
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

/** A display for the calls of these tools, unless `match` narrows them (by arguments, say). */
function toolDisplay(
  toolNames: string | string[],
  display: Omit<ToolDisplay, 'match' | 'cards'> & Partial<Pick<ToolDisplay, 'match' | 'cards'>>
): ToolDisplay {
  const names = [toolNames].flat();
  return {
    ...display,
    match: display.match ?? ((call) => names.includes(call.toolName)),
    cards: display.cards ?? argumentCards,
  };
}

const TOOL_DISPLAYS: ToolDisplay[] = [
  // Exa's tools, through the MCP bridge or from Bash, ahead of the generic
  // displays. Searches and fetches share one display, so a mix of them groups as pages.
  toolDisplay(['Bash', ...BRIDGE_CALLS], {
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
  toolDisplay(['Bash', ...BRIDGE_CALLS], {
    match: isDeepResearch,
    icon: BotIcon,
    describe: () => 'Deep research',
    groupLabel: (calls) => `Launched ${counted(calls.length, 'deep research task')}`,
    cards: mcpCards,
  }),
  toolDisplay('Bash', {
    icon: TerminalIcon,
    describe: ({ args }) => nonEmptyString(args.description),
    groupLabel: (calls) => `Ran ${counted(calls.length, 'command')}`,
    cards: mcpCards,
  }),
  toolDisplay('Read', {
    icon: EyeIcon,
    describe: ({ args }) => {
      const name = fileName(args);
      return name ? `Opened ${name}` : undefined;
    },
    groupLabel: (calls) => `Opened ${counted(calls.length, 'file')}`,
  }),
  toolDisplay('Edit', {
    icon: PenLineIcon,
    describe: ({ args }) => {
      const name = fileName(args);
      return name ? `Edited ${name}` : undefined;
    },
    groupLabel: (calls) => `Made ${counted(calls.length, 'edit')}`,
  }),
  toolDisplay('Write', {
    icon: PenLineIcon,
    describe: ({ args }) => {
      const name = fileName(args);
      return name ? `Wrote ${name}` : undefined;
    },
    groupLabel: (calls) => `Wrote ${counted(calls.length, 'file')}`,
  }),
  // Workers: `Task` starts one, `Agent` starts or resumes one.
  toolDisplay(['Task', 'Agent'], {
    icon: BotIcon,
    describe: ({ args }) => nonEmptyString(args.description),
    groupLabel: (calls) => `Delegated ${counted(calls.length, 'task')}`,
  }),
  toolDisplay('TaskStop', {
    icon: CircleStopIcon,
    describe: () => 'Stopped a task',
    groupLabel: (calls) => `Stopped ${counted(calls.length, 'task')}`,
  }),
  // The MCP bridge (Settings -> MCP servers): search, describe, then call a server's tool.
  toolDisplay(['mcp_search', 'mcp_describe', 'mcp_call', 'mcp_call_write'], {
    icon: PlugIcon,
    describe: ({ toolName, args }) => {
      if (toolName === 'mcp_search') {
        const query = nonEmptyString(args.query);
        return query ? `Looked for tools: ${query}` : 'Looked for tools';
      }
      const tool = mcpToolLabel(args.tool);
      if (!tool) return undefined;
      return toolName === 'mcp_describe' ? `Read about ${tool}` : `Used ${tool}`;
    },
    groupLabel: (calls) => `Made ${counted(calls.length, 'MCP call')}`,
    cards: mcpCards,
  }),
  // Generative UI: shown as a call only while it runs or when it failed.
  toolDisplay('present', {
    icon: LayoutDashboardIcon,
    describe: () => 'Interactive view',
    groupLabel: (calls) => `Showed ${counted(calls.length, 'view')}`,
  }),
];

const defaultLabel = ({ toolName }: ToolCall) => toolName;

/** Any other tool call, and groups of calls that show different displays. */
const DEFAULT_TOOL_DISPLAY: ToolDisplay = {
  match: () => true,
  icon: WrenchIcon,
  describe: defaultLabel,
  groupLabel: (calls) => `Used ${counted(calls.length, 'tool')}`,
  cards: argumentCards,
};

export function toolCall(toolName: string, argsText: string | undefined): ToolCall {
  return { toolName, argsText, args: parseToolArgs(argsText) };
}

export function getToolDisplay(call: ToolCall): ToolDisplay {
  return TOOL_DISPLAYS.find((display) => display.match(call)) ?? DEFAULT_TOOL_DISPLAY;
}

/**
 * Calls that only prepare the next ones (finding and reading about MCP tools):
 * a group's label is about what those next calls did, so these do not count,
 * and "search, describe, three web searches" reads as three web searches.
 */
const PREPARATORY_TOOLS = new Set(['mcp_search', 'mcp_describe']);

/** The calls a group's label is about: all of them when every one only prepares. */
function labelledCalls(calls: ToolCall[]): ToolCall[] {
  const doing = calls.filter((call) => !PREPARATORY_TOOLS.has(call.toolName));
  return doing.length > 0 ? doing : calls;
}

/** The display of a group: the one its calls share, or the default. */
export function getToolGroupDisplay(calls: ToolCall[]): ToolDisplay {
  const [first, ...rest] = labelledCalls(calls).map(getToolDisplay);
  return first && rest.every((display) => display === first) ? first : DEFAULT_TOOL_DISPLAY;
}

/** A group's trigger label, from the calls its display is about. */
export function getToolGroupLabel(calls: ToolCall[]): string {
  return getToolGroupDisplay(calls).groupLabel(labelledCalls(calls));
}

/** The trigger label of a single call. */
export function toolCallLabel(call: ToolCall): string {
  return getToolDisplay(call).describe(call) ?? defaultLabel(call);
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
