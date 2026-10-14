import { Hono } from 'hono';
import { config } from '../assistant/config';
import { MAX_RECORDING_BYTES } from '../assistant/filesystem/workspace-adapter.ts';
import { errorResponse } from '../http';
import { linkPreview } from '../link-preview';

/** Helpers of the chat UI: link previews and composer voice input. */
export const utilities = new Hono();

const GROQ_TRANSCRIPTIONS = 'https://api.groq.com/openai/v1/audio/transcriptions';

/** Title and description of a public page linked in a message. */
utilities.get('/link-preview', async (c) => {
  const href = c.req.query('url');
  if (!href || href.length > 4096) return Response.json({}, { status: 400 });
  try {
    return Response.json(await linkPreview(href), {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    // Preview failures do not prevent the original link from being displayed.
    return Response.json({}, { headers: { 'Cache-Control': 'public, max-age=60' } });
  }
});

/**
 * Transcribe a composer voice recording (multipart field `audio`) with Groq
 * Whisper. The language is auto-detected.
 *
 */
utilities.post('/transcribe', async (c) => {
  try {
    const { groqApiKey, model } = config.transcription;
    if (!groqApiKey) return errorResponse('Voice input needs GROQ_API_KEY (see .env.example)', 503);

    const bounded = await readBoundedBody(c.req.raw, MAX_RECORDING_BYTES + 1024 * 1024);
    if (!bounded.ok) return errorResponse(bounded.error, bounded.status);
    const request = new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body: new Uint8Array(bounded.body) });
    const form = await request.formData().catch(() => null);
    const audio = form?.get('audio');
    if (!(audio instanceof File) || audio.size === 0) return errorResponse('Missing audio', 400);
    if (audio.size > MAX_RECORDING_BYTES) return errorResponse('Recording is larger than 25 MB', 413);

    const body = new FormData();
    body.set('file', audio, audio.name || 'recording.webm');
    body.set('model', model);
    body.set('response_format', 'json');
    body.set('temperature', '0');
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]);
    const res = await fetch(GROQ_TRANSCRIPTIONS, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}` },
      body,
      signal,
    });
    if (!res.ok) {
      const detail = (await readResponseText(res, 1024)).slice(0, 300);
      return errorResponse(`Transcription failed (${res.status}) ${detail}`.trim(), 502);
    }
    const parsed = JSON.parse(await readResponseText(res, 1024 * 1024)) as { text?: unknown };
    if (parsed.text !== undefined && typeof parsed.text !== 'string') return errorResponse('Transcription provider returned an invalid response', 502);
    return Response.json(
      { text: parsed.text?.trim() ?? '' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return errorResponse(error, 502);
  }
});

async function readBoundedBody(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; body: Buffer } | { ok: false; status: number; error: string }> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return { ok: false, status: 413, error: 'Request body is too large' };
  }
  if (!request.body) return { ok: true, body: Buffer.alloc(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: 'Request body is too large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, body: Buffer.concat(chunks, size) };
}

async function readResponseText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('Transcription provider response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}
