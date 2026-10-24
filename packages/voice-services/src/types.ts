/** The LiveKit settings the token issuer needs; the gateway passes its config.livekit from compose.ts. */
export interface LiveKitSettings {
  url: string;
  apiKey: string;
  apiSecret: string;
  agentName: string;
}
