import type { ImageContent } from '@letta-ai/letta-agent-sdk';
import type { ChatAttachment, Modality, TextEffort } from '../../chat-types';
import type { UpdateRecord } from '../background/store.ts';

export interface TurnRequest {
  /** The user's words; empty for a turn that only delivers background updates. */
  text: string;
  modality: Modality;
  /** Text-only user preference; voice keeps using the fast model. */
  effort?: TextEffort;
  /** `update` turns deliver finished background work into the conversation. */
  kind?: 'user' | 'update';
  /** Background updates this turn delivers. Held updates are added to any turn. */
  updates?: UpdateRecord[];
  /** Files the user attached (in the workspace), and the images among them. */
  attachments?: ChatAttachment[];
  images?: ImageContent[];
  /** Abort the turn (e.g. the voice user interrupted). */
  signal?: AbortSignal;
  /** Stable client supplied identity used to reconcile reconnecting chat submissions. */
  clientMessageId?: string;
  /** Receives assistant text as it streams (used by the voice endpoints). */
  onText?: (delta: string) => void;
}

export interface TurnOutcome {
  success: boolean;
  text: string;
  error?: string;
}
