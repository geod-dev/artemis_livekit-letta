import { randomUUID } from 'node:crypto';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import type { AppConfig } from '../../config';

/** The browser's connection details for a LiveKit room. */
export interface VoiceToken {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

/** Mints the LiveKit tokens the voice routes hand to the browser. */
export interface VoiceTokenIssuer {
  /** A call on a conversation: a fresh room, with the voice agent dispatched into it. */
  forCall(conversationId: string, callMode: 'short' | 'long'): Promise<VoiceToken>;
  /** Warms the connection before any conversation exists: a room with no agent. */
  warmup(): Promise<VoiceToken>;
}

const PARTICIPANT_NAME = 'user';
type Grant = Parameters<AccessToken['addGrant']>[0];

export function createVoiceTokenIssuer(livekit: AppConfig['livekit']): VoiceTokenIssuer {
  const issue = async (
    roomName: string,
    ttl: string,
    grant: Omit<Grant, 'room'>,
    dispatch?: { conversationId: string; callMode: 'short' | 'long' }
  ): Promise<VoiceToken> => {
    const token = new AccessToken(livekit.apiKey, livekit.apiSecret, {
      identity: `user-${randomUUID().slice(0, 8)}`,
      name: PARTICIPANT_NAME,
      ttl,
    });
    token.addGrant({ ...grant, room: roomName });
    if (dispatch) {
      token.roomConfig = new RoomConfiguration({
        agents: [
          new RoomAgentDispatch({
            agentName: livekit.agentName,
            metadata: JSON.stringify({
              conversation_id: dispatch.conversationId,
              call_mode: dispatch.callMode,
            }),
          }),
        ],
      });
    }
    return {
      serverUrl: livekit.url,
      roomName,
      participantName: PARTICIPANT_NAME,
      participantToken: await token.toJwt(),
    };
  };
  return {
    forCall: (conversationId, callMode) =>
      issue(
        `call-${conversationId}-${randomUUID().slice(0, 8)}`,
        '30m',
        { roomJoin: true, canPublish: true, canPublishData: true, canSubscribe: true },
        { conversationId, callMode }
      ),
    warmup: () => issue(`warmup-${randomUUID().slice(0, 8)}`, '5m', { roomJoin: true }),
  };
}
