import { Hono } from 'hono';
import { config } from '../assistant/config';
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
 * NOTE: no auth layer — this is a single-user local prototype.
 */
utilities.post('/transcribe', async (c) => {
  try {
    const { groqApiKey, model } = config.transcription;
    if (!groqApiKey) return errorResponse('Voice input needs GROQ_API_KEY (see .env.example)', 503);

    const form = await c.req.formData().catch(() => null);
    const audio = form?.get('audio');
    if (!(audio instanceof File) || audio.size === 0) return errorResponse('Missing audio', 400);

    const body = new FormData();
    body.set('file', audio, audio.name || 'recording.webm');
    body.set('model', model);
    body.set('response_format', 'json');
    body.set('temperature', '0');
    const res = await fetch(GROQ_TRANSCRIPTIONS, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}` },
      body,
      signal: c.req.raw.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return errorResponse(`Transcription failed (${res.status}) ${detail}`.trim(), 502);
    }
    const { text } = (await res.json()) as { text?: string };
    return Response.json(
      { text: text?.trim() ?? '' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return errorResponse(error);
  }
});
