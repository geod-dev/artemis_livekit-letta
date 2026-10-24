import { VOICE_DISPATCH_KEYS } from '@artemis/contracts/agent-server';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import type { LiveKitSettings } from '../../types.ts';

/** The browser's connection details for a LiveKit room (the route's VoiceToken). */
interface VoiceToken {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

const PARTICIPANT_NAME = 'user';
type Grant = Parameters<AccessToken['addGrant']>[0];

/**
 * Mints the LiveKit tokens the voice routes hand to the browser, matching the
 * route's VoiceTokenPort: a call on a conversation (a fresh room with the voice
 * agent dispatched into it) and a warm-up before any conversation exists (a room
 * with no agent).
 */
export function createVoiceTokenIssuer(livekit: LiveKitSettings) {
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
              [VOICE_DISPATCH_KEYS.conversationId]: dispatch.conversationId,
              [VOICE_DISPATCH_KEYS.callMode]: dispatch.callMode,
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
    forCall: (conversationId: string, callMode: 'short' | 'long'): Promise<VoiceToken> =>
      issue(
        `call-${conversationId}-${randomUUID().slice(0, 8)}`,
        '30m',
        { roomJoin: true, canPublish: true, canPublishData: true, canSubscribe: true },
        { conversationId, callMode }
      ),
    warmup: () => issue(`warmup-${randomUUID().slice(0, 8)}`, '5m', { roomJoin: true }),
  };
}
