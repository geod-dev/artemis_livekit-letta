import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAT_HTTP } from '@artemis/contracts/chat-http';
import { MAX_ATTACHMENT_BYTES } from '@artemis/contracts/chat-types';
import { recordingEnd } from '@/hooks/voice-recording-end';
import { apiFetch } from '@/lib/api';

/** 'limit': the recording was cut at a limit; the audio is kept until it is stopped or sent. */
export type RecordingStatus = 'idle' | 'recording' | 'limit' | 'transcribing';

/** The limit that cut a recording short. */
export type CutReason = 'duration' | 'size';

export type VoiceRecorder = ReturnType<typeof useVoiceRecorder>;

type Recording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  context: AudioContext;
  chunks: Blob[];
  bytes: number;
  stopped: Promise<void>;
  tooLong: boolean;
  tooLarge: boolean;
  durationTimer: ReturnType<typeof setTimeout>;
};

export const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000;

// Formats Groq accepts, in order of preference; the browser records the first it supports.
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

const extension = (mimeType: string) =>
  mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';

/**
 * Connects the level meter to the microphone and starts the recorder. When any step
 * fails, the AudioContext created for the meter is closed, so failed starts do not pile up.
 */
export function openCapture(
  stream: MediaStream,
  recorder: MediaRecorder,
  createContext: () => AudioContext
): { context: AudioContext; node: AnalyserNode } {
  const context = createContext();
  try {
    const node = context.createAnalyser();
    node.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(node);
    recorder.start(1000);
    return { context, node };
  } catch (error) {
    void context.close().catch(() => {});
    throw error;
  }
}

/**
 * Ends a recording at a limit: the recorder stops, the microphone is released, and the
 * caller is told which limit was hit so the UI leaves the recording state.
 */
export function cutCapture(
  recording: Pick<Recording, 'recorder' | 'tooLong' | 'tooLarge'>,
  reason: CutReason,
  releaseCapture: () => void,
  onCut: (reason: CutReason) => void
): void {
  if (reason === 'duration') recording.tooLong = true;
  else recording.tooLarge = true;
  if (recording.recorder.state !== 'inactive') recording.recorder.stop();
  releaseCapture();
  onCut(reason);
}

/**
 * Appends a dictated transcript to the composer text. Returns null when the result would
 * exceed the message limit, so the caller can refuse it instead of sending a rejected message.
 */
export function appendTranscript(current: string, text: string, maxLength: number): string | null {
  const next = current.trim() ? `${current.trimEnd()} ${text}` : text;
  return next.length > maxLength ? null : next;
}

/**
 * Records the microphone for the composer, then transcribes the recording with
 * Groq Whisper (/api/transcribe). `analyser` feeds the live waveform.
 */
export function useVoiceRecorder() {
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [limit, setLimit] = useState<CutReason | null>(null);
  const recording = useRef<Recording | null>(null);
  const transcription = useRef<AbortController | null>(null);
  const active = useRef(false);
  // Bumped by cancel (and unmount) so a pending start or stop knows it was abandoned.
  const generation = useRef(0);

  /** Turn the microphone off. The recorder still delivers its last chunk. */
  const release = useCallback(() => {
    const current = recording.current;
    recording.current = null;
    setAnalyser(null);
    if (!current) return;
    clearTimeout(current.durationTimer);
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    current.stream.getTracks().forEach((track) => track.stop());
    void current.context.close().catch(() => {});
  }, []);

  const reset = useCallback(() => {
    active.current = false;
    setStartedAt(null);
    setLimit(null);
    setStatus('idle');
  }, []);

  /** Discard the recording, or the transcription in flight. */
  const cancel = useCallback(() => {
    generation.current++;
    transcription.current?.abort();
    transcription.current = null;
    release();
    reset();
  }, [release, reset]);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    const id = ++generation.current;
    setStatus('recording');
    let stream: MediaStream | undefined;
    try {
      if (!window.isSecureContext) {
        throw new Error('Microphone access requires HTTPS. Open this site over HTTPS to record.');
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone recording is not supported by this browser.');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (id !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000,
      });
      const chunks: Blob[] = [];
      let resolveStopped!: () => void;
      const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });
      recorder.addEventListener('stop', resolveStopped, { once: true });
      const { context, node } = openCapture(stream, recorder, () => new AudioContext());
      const recordingData: Recording = {
        recorder,
        stream,
        context,
        chunks,
        bytes: 0,
        stopped,
        tooLong: false,
        tooLarge: false,
        durationTimer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      const releaseCapture = () => {
        stream?.getTracks().forEach((track) => track.stop());
        setAnalyser(null);
        void context.close().catch(() => {});
      };
      const onCut = (reason: CutReason) => {
        if (recording.current !== recordingData) return;
        setLimit(reason);
        setStatus('limit');
      };
      recorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        recordingData.bytes += event.data.size;
        if (recordingData.bytes > MAX_ATTACHMENT_BYTES) {
          cutCapture(recordingData, 'size', releaseCapture, onCut);
          return;
        }
        chunks.push(event.data);
      };
      recordingData.durationTimer = setTimeout(() => {
        cutCapture(recordingData, 'duration', releaseCapture, onCut);
      }, MAX_RECORDING_DURATION_MS);
      recording.current = recordingData;
      setAnalyser(node);
      setStartedAt(Date.now());
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (id === generation.current) cancel();
      throw error;
    }
  }, [cancel]);

  /**
   * Stop recording and transcribe it. Resolves to the transcript ('' when
   * nothing was heard), or null when there was nothing to stop or the
   * recording was cancelled meanwhile.
   */
  const stop = useCallback(async (): Promise<string | null> => {
    const current = recording.current;
    if (!current) return null;
    const id = generation.current;
    clearTimeout(current.durationTimer);
    if (current.recorder.state !== 'inactive') release();
    else {
      current.stream.getTracks().forEach((track) => track.stop());
      setAnalyser(null);
      void current.context.close().catch(() => {});
    }
    setStatus('transcribing');
    await current.stopped;
    if (id !== generation.current) return null;
    const type = current.recorder.mimeType || 'audio/webm';
    const audio = new Blob(current.chunks, { type });
    const end = recordingEnd(
      { tooLarge: current.tooLarge, tooLong: current.tooLong, size: audio.size },
      MAX_ATTACHMENT_BYTES
    );
    if (end === 'too-large' || end === 'too-long') {
      reset();
      throw new Error(
        end === 'too-long'
          ? 'Recording reached the 5 minute limit'
          : `Recording is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`
      );
    }
    if (end === 'empty') {
      reset();
      return '';
    }
    const controller = new AbortController();
    transcription.current = controller;
    try {
      const body = new FormData();
      body.set('audio', audio, `recording.${extension(type)}`);
      const res = await apiFetch(CHAT_HTTP.transcribe, {
        method: 'POST',
        body,
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Transcription failed (${res.status})`);
      return data.text ?? '';
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      if (transcription.current === controller) {
        transcription.current = null;
        reset();
      }
    }
  }, [release, reset]);

  return { status, analyser, startedAt, limit, start, stop, cancel };
}
