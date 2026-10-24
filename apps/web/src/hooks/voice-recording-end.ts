/** How a finished recording is handled: the decision the voice recorder's stop makes. */
export type RecordingEnd = 'too-large' | 'too-long' | 'empty' | 'transcribe';

/**
 * Decides what a finished recording becomes. The limits win over emptiness, and
 * a recording that was cut for length or size is never transcribed, even though
 * the cut audio is still there.
 */
export function recordingEnd(
  recording: { tooLarge: boolean; tooLong: boolean; size: number },
  maxBytes: number
): RecordingEnd {
  if (recording.tooLarge) return 'too-large';
  if (recording.tooLong) return 'too-long';
  if (recording.size === 0) return 'empty';
  if (recording.size > maxBytes) return 'too-large';
  return 'transcribe';
}
