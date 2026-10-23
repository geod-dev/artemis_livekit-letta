import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceRecorderStatus = 'idle' | 'recording' | 'transcribing';

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

const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000;

// Formats Groq accepts, in order of preference; the browser records the first it supports.
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

const extension = (mimeType: string) =>
  mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';

/**
 * Records the microphone for the composer, then transcribes the recording with
 * Groq Whisper (/api/transcribe). `analyser` feeds the live waveform.
 */
export function useVoiceRecorder() {
  const [status, setStatus] = useState<VoiceRecorderStatus>('idle');
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
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
      const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
      recorder.addEventListener('stop', resolveStopped, { once: true });
      const context = new AudioContext();
      const node = context.createAnalyser();
      node.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(node);
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
      recorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        recordingData.bytes += event.data.size;
        if (recordingData.bytes > MAX_RECORDING_BYTES) {
          recordingData.tooLarge = true;
          if (recorder.state !== 'inactive') recorder.stop();
          releaseCapture();
          return;
        }
        chunks.push(event.data);
      };
      recordingData.durationTimer = setTimeout(() => {
        recordingData.tooLong = true;
        if (recorder.state !== 'inactive') recorder.stop();
        releaseCapture();
      }, MAX_RECORDING_DURATION_MS);
      recording.current = recordingData;
      recorder.start(1000);
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
    if (current.tooLarge) {
      reset();
      throw new Error('Recording is larger than 25 MB');
    }
    if (current.tooLong) {
      reset();
      throw new Error('Recording reached the 5 minute limit');
    }

    const type = current.recorder.mimeType || 'audio/webm';
    const audio = new Blob(current.chunks, { type });
    if (audio.size === 0) {
      reset();
      return '';
    }
    if (audio.size > MAX_RECORDING_BYTES) {
      reset();
      throw new Error('Recording is larger than 25 MB');
    }
    const controller = new AbortController();
    transcription.current = controller;
    try {
      const body = new FormData();
      body.set('audio', audio, `recording.${extension(type)}`);
      const res = await fetch('/api/transcribe', {
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

  return { status, analyser, startedAt, start, stop, cancel };
}
