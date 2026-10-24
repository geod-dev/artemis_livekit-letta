/** Newest `limit` bytes of a text stream; older text is dropped behind a notice. */
export class BoundedLog {
  private readonly pieces: { text: string; bytes: number }[] = [];
  private head = 0;
  private retainedBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    this.pieces.push({ text, bytes });
    this.retainedBytes += bytes;
    while (this.retainedBytes > this.limit && this.pieces.length - this.head > 1) {
      const old = this.pieces[this.head++]!;
      this.retainedBytes -= old.bytes;
      this.droppedBytes += old.bytes;
    }
    if (this.retainedBytes > this.limit) {
      const last = this.pieces[this.pieces.length - 1]!;
      const buffer = Buffer.from(last.text);
      const kept = buffer.subarray(buffer.length - this.limit);
      this.droppedBytes += buffer.length - kept.length;
      last.text = kept.toString('utf8');
      last.bytes = kept.length;
      this.retainedBytes = kept.length;
    }
    if (this.head > 1024 && this.head * 2 > this.pieces.length) {
      this.pieces.splice(0, this.head);
      this.head = 0;
    }
  }

  toString(): string {
    const body = this.pieces
      .slice(this.head)
      .map((piece) => piece.text)
      .join('');
    return this.droppedBytes > 0 ? `[output truncated: ${this.droppedBytes} bytes omitted]\n${body}` : body;
  }
}
