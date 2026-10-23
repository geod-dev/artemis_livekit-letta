import { Hono } from 'hono';
import { MAX_UPLOAD_BYTES } from '../attachments/attachment-policy';
import { errorResponse, requestLimit } from '../http';
/** The speech-to-text port of this route; the provider is chosen in compose. */
export interface TranscriptionPort {
  /** False when no key is configured; `transcribe` must not be called then. */
  readonly enabled: boolean;
  /** The trimmed transcript; provider failures throw. */
  transcribe(audio: File, signal?: AbortSignal): Promise<string>;
}

/** Multipart framing around a recording is small; the limit counts the whole request body. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/**
 * Speech-to-text for the composer's voice input (multipart field `audio`). The
 * language is auto-detected; the provider sits behind the injected Transcriber.
 *
 * Responds 503 when no transcription key is configured, 413 for a recording over
 * the upload limit, 400 for a missing recording, and 502 when the provider fails.
 */
export function createTranscriptionRoutes({ transcriber }: { transcriber: TranscriptionPort }): Hono {
  const routes = new Hono();

  routes.post('/transcribe', requestLimit(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES), async (c) => {
    if (!transcriber.enabled) return errorResponse('Voice input needs GROQ_API_KEY (see .env.example)', 503);
    try {
      const form = await c.req.raw.formData().catch(() => null);
      const audio = form?.get('audio');
      if (!(audio instanceof File) || audio.size === 0) return errorResponse('Missing audio', 400);
      if (audio.size > MAX_UPLOAD_BYTES)
        return errorResponse(`Recording is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`, 413);
      const text = await transcriber.transcribe(audio, c.req.raw.signal);
      return Response.json({ text }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return errorResponse(error, 502);
    }
  });

  return routes;
}
