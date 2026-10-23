/**
 * Composition root for the gateway: builds the dependencies its modules receive.
 * The gateway has no vendor implementations; its only outbound connection is the
 * agent-server HTTP client.
 */
import { AgentServerClient } from './agent-server/client';
import type { AppConfig } from './assistant/config';

export interface GatewayDependencies {
  agentServer: AgentServerClient;
}

export function composeGateway(config: AppConfig): GatewayDependencies {
  return { agentServer: new AgentServerClient(config.agentServer) };
}
