/**
 * Hand background-task notifications to the assistant gateway.
 *
 * Letta queues a <task-notification> into the parent conversation when a
 * background worker finishes, and starts a turn with it as soon as the
 * conversation is idle. The gateway decides instead whether and how the
 * assistant is told (call mode, live call, read state), so this mod forwards
 * the notifications and removes them from the turn. When the gateway cannot
 * take them, the turn proceeds unchanged and Letta delivers them natively.
 */

const BLOCK =
  /<task-notification>(?=[\s\S]*?<task-id>)(?=[\s\S]*?<status>)[\s\S]*?<\/task-notification>(?:\nFull transcript available at: [^\n]*)?/g;

function textOf(part) {
  return typeof part === 'string' ? part : part?.type === 'text' ? part.text : null;
}

/** Remove notifications from one user message; returns [message or null, notifications]. */
function splitMessage(message) {
  const found = [];
  const strip = (text) =>
    text.replace(BLOCK, (block) => {
      found.push(block);
      return '';
    });
  let content;
  if (typeof message.content === 'string') {
    content = strip(message.content);
  } else if (Array.isArray(message.content)) {
    content = message.content
      .map((part) => {
        const text = textOf(part);
        if (text === null) return part;
        const stripped = strip(text);
        return typeof part === 'string' ? stripped : { ...part, text: stripped };
      })
      .filter((part) => textOf(part) === null || textOf(part).trim());
  } else {
    return [message, found];
  }
  if (!found.length) return [message, found];
  // Letta prepends system reminders to the turn; alone they are not worth a turn.
  const words = (Array.isArray(content) ? content.map(textOf).join('') : content)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
  return [words ? { ...message, content } : null, found];
}

export default function activate(letta) {
  const gateway = process.env.ASSISTANT_GATEWAY_URL;
  // Workers run as separate Letta processes that load the same mods.
  if (!gateway || process.env.LETTA_CODE_AGENT_ROLE === 'subagent') return;
  if (!letta.capabilities.events?.turns) return;

  return letta.events.on('turn_start', async (event) => {
    const input = [];
    const notifications = [];
    for (const item of event.input) {
      if (item.type === 'approval' || item.role !== 'user') {
        input.push(item);
        continue;
      }
      const [message, found] = splitMessage(item);
      notifications.push(...found);
      if (message) input.push(message);
    }
    if (!notifications.length) return;

    try {
      const response = await fetch(`${gateway.replace(/\/$/, '')}/api/letta/notifications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LETTA_SERVER_TOKEN ?? ''}`,
        },
        body: JSON.stringify({
          agentId: event.agentId,
          conversationId: event.conversationId,
          notifications,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      letta.diagnostics?.report?.({
        message: `Gateway did not take ${notifications.length} notification(s); delivering natively: ${error}`,
        severity: 'warning',
      });
      return;
    }

    const hasUserInput = input.some((item) => item.type !== 'approval' && item.role === 'user');
    return hasUserInput
      ? { input }
      : { cancel: { reason: 'Notifications delivered by the assistant gateway' } };
  });
}
