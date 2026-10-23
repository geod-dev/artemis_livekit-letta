type ResponseState = 'listen' | 'done';

const TRAILING_STATE_MARKER = /\s*\[(listen|done)\]\s*$/i;

/**
 * Holds back a trailing `[listen]`/`[done]` marker from streamed voice text
 * (the call-state filter of voice turns). The marker is the assistant's call
 * state for the response: it is never spoken or shown.
 */
export class CallStateFilter {
  /** The state found at the end of the response, once `flush` ran. */
  state: ResponseState | null = null;
  private held = '';

  /** Text that can be spoken now; a possible marker start is held back. */
  push(delta: string): string {
    let text = this.held + delta;
    this.held = '';
    const open = text.lastIndexOf('[');
    if (open >= 0) {
      const tail = text.slice(open).toLowerCase();
      const marker = ['[listen]', '[done]'].some((value) => value.startsWith(tail));
      if (marker && tail.length <= '[listen]'.length) {
        // Hold a possible trailing marker until the stream ends. If later text
        // follows, this was user-facing prose and is released unchanged.
        const start = text.slice(0, open).trimEnd().length;
        this.held = text.slice(start);
        text = text.slice(0, start);
      }
    }
    return text;
  }

  /** Text held back at the end of a step: a marker is consumed and sets `state`. */
  flush(): string {
    const match = this.held.match(TRAILING_STATE_MARKER);
    if (match) this.state = match[1]!.toLowerCase() as ResponseState;
    const rest = match ? this.held.slice(0, match.index) : this.held;
    this.held = '';
    return rest;
  }
}
