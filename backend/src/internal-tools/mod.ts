import type { ToolSpec } from './types';

/**
 * Rendering a Letta mod that registers native tools which call the backend.
 *
 * A mod is Letta's supported way to add client tools: a file in the server's
 * global mods directory (`~/.letta/mods`) whose default export calls
 * `letta.tools.register(...)`. The assistant's turns get those tools;
 * subagents do not (they run a providers-only capability profile).
 *
 * The mod is a thin shape: each tool POSTs its arguments to the backend's
 * `/api/letta/tools/<name>` (see routes/letta.ts) at `ASSISTANT_GATEWAY_URL`,
 * with the shared Letta token like `letta/notifications.mjs`, and returns what
 * the backend answers. The work lives in the backend; a mod needs a `reload`
 * to change (`install.ts`) and cannot import npm packages, so it holds as
 * little as possible.
 */

export const MODS_DIR = '/root/.letta/mods';

export function renderToolsMod(options: {
  /** First comment line: identifies the mod and its render version. */
  title: string;
  tools: readonly ToolSpec[];
}): string {
  const header = `// ${options.title}: rendered by the backend (backend/src/internal-tools/mod.ts).
// Edits here are overwritten on the backend's next connect.`;
  if (options.tools.length === 0) {
    // The protocol cannot delete a file, so "no tools" is a mod that registers nothing.
    return `${header}
// No tools right now: registers nothing.
export default function activate() {}
`;
  }
  return `${header}
const TOOLS = ${JSON.stringify(options.tools, null, 2)};

async function callBackend(tool, ctx) {
  const gateway = process.env.ASSISTANT_GATEWAY_URL;
  if (!gateway) {
    return { status: "error", content: "The " + tool + " tool is not configured (no ASSISTANT_GATEWAY_URL)." };
  }
  let response;
  try {
    response = await fetch(gateway.replace(/\\/$/, "") + "/api/letta/tools/" + tool, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer " + (process.env.LETTA_SERVER_TOKEN ?? ""),
      },
      body: JSON.stringify(ctx.args ?? {}),
      signal: ctx.signal,
    });
  } catch (error) {
    return { status: "error", content: "The " + tool + " tool is unreachable right now (" + (error?.message ?? error) + "). Try again shortly." };
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body.text !== "string") {
    return { status: "error", content: "The " + tool + " tool answered HTTP " + response.status + " with no result." };
  }
  return body.isError ? { status: "error", content: body.text } : body.text;
}

export default function activate(letta) {
  if (!letta.capabilities?.tools) return;
  const disposers = TOOLS.map((tool) =>
    letta.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // "ask" follows the permission mode; "auto" never prompts.
      requiresApproval: tool.approval === "ask",
      ...(tool.approval === "ask" ? { approvalPolicy: "ask" } : {}),
      parallelSafe: tool.approval !== "ask",
      run: (ctx) => callBackend(tool.name, ctx),
    }),
  );
  return () => {
    for (const dispose of disposers) if (typeof dispose === "function") dispose();
  };
}
`;
}
