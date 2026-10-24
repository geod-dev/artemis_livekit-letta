import { AppError, isRecord, NotFoundError } from '@artemis/core';
import { jsonObject } from '@artemis/http';
import {
  type ChatAttachment,
  MAX_TURN_ATTACHMENTS,
  TEXT_EFFORTS,
  type TextEffort,
} from '@artemis/contracts/chat-types';
import type { Context, Next } from 'hono';

/** Request validation: body, query and path checks shared by the route modules. Each failure is a 4xx AppError. */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Call ids are `prefixedId('call')` from @artemis/core: `call_` and 32 hex digits. */
const CALL_ID_PATTERN = /^call_[0-9a-f]{32}$/;
const ATTACHMENT_KINDS: readonly ChatAttachment['kind'][] = ['image', 'file'];
/** Voice completions: the messages list and the text of one message. */
export const MAX_VOICE_MESSAGES = 100;
const MAX_VOICE_CONTENT = 100_000;
/** Background update ids accepted by one read request. */
export const MAX_UPDATE_IDS = 500;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isCallId(value: string): boolean {
  return CALL_ID_PATTERN.test(value);
}

/** A call id from a request header, or null when it is absent or not in the call id format. */
export function validCallId(header: string | null): string | null {
  return header !== null && isCallId(header) ? header : null;
}

/**
 * Route guard for a path parameter that is a uuid key (conversation, background update).
 * A value that is not a uuid cannot name a row, so it answers 404 here instead of letting
 * Postgres reject the cast as a 500. `reserved` lists literal segments that share the position.
 */
export function requireUuidParam(name: string, what: string, reserved: readonly string[] = []) {
  return async (c: Context, next: Next) => {
    const value = c.req.param(name) ?? '';
    if (!reserved.includes(value) && !isUuid(value)) throw new NotFoundError(what);
    await next();
  };
}

/** A required JSON object body, or 400 `invalid_body`. */
export async function requireBody(request: Request, message = 'Body must be a JSON object'): Promise<Record<string, unknown>> {
  const body = await jsonObject(request);
  if (!body) throw new AppError('invalid_body', message, 400);
  return body;
}

/** An optional JSON object body: an empty body is `{}`, a malformed one is 400. */
export async function optionalBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  const text = await request.clone().text().catch(() => '');
  if (text.trim() === '') return {};
  return requireBody(request);
}

/** A string field with a length bound, or 400 `invalid_field`. */
export function requireString(body: Record<string, unknown>, field: string, max: number, min = 1): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new AppError('invalid_field', `${field} must be a string of ${min} to ${max} characters`, 400);
  }
  return value;
}

/** Optional `limit` query parameter (1..max), default `fallback`. */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError('invalid_limit', `limit must be an integer from 1 to ${max}`, 400);
  }
  return value;
}

export function invalidField(message: string): AppError {
  return new AppError('invalid_field', message, 400);
}


export function optionalList(body: Record<string, unknown>, field: string, max: number): unknown[] {
  const value = body[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw invalidField(`${field} must be a list of at most ${max} entries`);
  }
  return value;
}

/** The uploads of a turn, each checked before the turn exists. Only the known fields are kept. */
export function parseAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TURN_ATTACHMENTS) {
    throw invalidField(`attachments must be a list of at most ${MAX_TURN_ATTACHMENTS} entries`);
  }
  return value.map((entry, index) => parseAttachment(entry, `attachments[${index}]`));
}

function parseAttachment(value: unknown, field: string): ChatAttachment {
  if (!isRecord(value)) throw invalidField(`${field} must be an object`);
  const kind = ATTACHMENT_KINDS.find((item) => item === value.kind);
  if (!kind) throw invalidField(`${field}.kind must be one of ${ATTACHMENT_KINDS.join(', ')}`);
  const { path, name, mimeType, size } = value;
  if (typeof path !== 'string' || path === '') throw invalidField(`${field}.path must be a non-empty string`);
  if (typeof name !== 'string') throw invalidField(`${field}.name must be a string`);
  if (mimeType !== undefined && typeof mimeType !== 'string') throw invalidField(`${field}.mimeType must be a string`);
  if (size !== undefined && typeof size !== 'number') throw invalidField(`${field}.size must be a number`);
  return {
    path,
    name,
    kind,
    ...(typeof mimeType === 'string' ? { mimeType } : {}),
    ...(typeof size === 'number' ? { size } : {}),
  };
}

export function requireEffort(value: unknown): TextEffort {
  if (typeof value === 'string' && (TEXT_EFFORTS as readonly string[]).includes(value)) return value as TextEffort;
  throw invalidField(`effort must be one of ${TEXT_EFFORTS.join(', ')}`);
}

/** The messages of a voice completion request (LiveKit's OpenAI-compatible body), bounded in count and size. */
export function validMessages(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > MAX_VOICE_MESSAGES) return false;
  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (typeof row.role !== 'string' || row.role.length > 32) return false;
    const content = row.content;
    if (content === undefined || content === null) return true;
    if (typeof content === 'string') return content.length <= MAX_VOICE_CONTENT;
    if (Array.isArray(content)) {
      return (
        content.length <= MAX_VOICE_MESSAGES &&
        content.every((part) => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
          return !('text' in part) || typeof (part as { text?: unknown }).text === 'string';
        })
      );
    }
    return false;
  });
}
