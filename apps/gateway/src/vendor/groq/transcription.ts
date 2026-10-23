/** Speech-to-text for the composer's voice input, through Groq's OpenAI-compatible Whisper endpoint. */
export interface Transcriber {
  /** False when no Groq key is configured; `transcribe` must not be called then. */
  readonly enabled: boolean;
  /** The transcript, trimmed. Provider failures throw; the caller maps them to a 502. */
  transcribe(audio: File, signal?: AbortSignal): Promise<string>;
}

export interface GroqTranscriberOptions {
  apiKey?: string;
  model: string;
  fetch?: typeof globalThis.fetch;
}

const GROQ_TRANSCRIPTIONS = 'https://api.groq.com/openai/v1/audio/transcriptions';
const PROVIDER_TIMEOUT_MS = 60_000;
const PROVIDER_ERROR_DETAIL_BYTES = 1024;
const PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export function createGroqTranscriber(options: GroqTranscriberOptions): Transcriber {
  const apiKey = options.apiKey;
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  return {
    enabled: Boolean(apiKey),
    async transcribe(audio, signal) {
      if (!apiKey) throw new Error('Voice input needs GROQ_API_KEY (see .env.example)');
      const body = new FormData();
      body.set('file', audio, audio.name || 'recording.webm');
      body.set('model', options.model);
      body.set('response_format', 'json');
      body.set('temperature', '0');
      const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      const response = await send(GROQ_TRANSCRIPTIONS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        const detail = (await readBounded(response, PROVIDER_ERROR_DETAIL_BYTES)).slice(0, 300);
        throw new Error(`Transcription failed (${response.status}) ${detail}`.trim());
      }
      const parsed = JSON.parse(await readBounded(response, PROVIDER_RESPONSE_BYTES)) as {
        text?: unknown;
      };
      if (parsed.text !== undefined && typeof parsed.text !== 'string')
        throw new Error('Transcription provider returned an invalid response');
      return parsed.text?.trim() ?? '';
    },
  };
}

/** Reads a provider body as text, refusing anything over `limit` bytes. */
async function readBounded(response: Response, limit: number): Promise<string> {
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
