/**
 * Browser-to-gateway HTTP route paths, shared by the gateway's route mounts and
 * the web client. Route handlers live in apps/gateway; this file only names them.
 */
export const CHAT_HTTP = {
  auth: '/api/auth',
  attachments: '/api/attachments',
  workspace: '/api/workspace',
  transcribe: '/api/transcribe',
  linkPreview: '/api/link-preview',
  voice: '/api/voice',
  voiceToken: '/api/voice/token',
  conversations: '/api/conversations',
  mcp: '/api/mcp',
  devices: '/api/devices',
  /** A sub-route of one conversation: pass it as the suffix of `conversationRoute(id, ...)`. */
  conversationContextUsage: '/context-usage',
} as const;
