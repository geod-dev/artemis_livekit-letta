import { DEFAULT_BACKGROUND_AFTER_MS } from '../names.ts';
import type { ToolContext } from '../context.ts';
import type { AnyTool } from '../tool.ts';
import { BashTool } from './bash.ts';
import { DeleteFileTool, EditFileTool, ListFilesTool, ReadFileTool, SearchFilesTool, WriteFileTool } from './files.ts';
import type { WorkspaceToolsOptions } from './types.ts';

export type { CommandHandoff, WorkspaceToolsOptions } from './types.ts';
export { BashTool, type BashInput } from './bash.ts';
export { DeleteFileTool, EditFileTool, ListFilesTool, ReadFileTool, SearchFilesTool, WriteFileTool } from './files.ts';
export { describeBinary, imageType, isTextContent } from './media.ts';

/**
 * The default workspace tools, in `TOOL_NAMES` order:
 * read_file, write_file, edit_file, delete_file, list_files, search_files, bash.
 * Writes respect `context.access.readOnlyPrefixes` (`data/`). Execution policy
 * (interactive handoff vs synchronous) is read from `context.policy` per call.
 */
export function createWorkspaceTools(options: WorkspaceToolsOptions): AnyTool<ToolContext>[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new DeleteFileTool(),
    new ListFilesTool(),
    new SearchFilesTool(),
    new BashTool({
      handoff: options.handoff,
      backgroundAfterMs: options.backgroundAfterMs ?? DEFAULT_BACKGROUND_AFTER_MS,
    }),
  ];
}
