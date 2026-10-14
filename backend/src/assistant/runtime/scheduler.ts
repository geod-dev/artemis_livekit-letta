/** FIFO serialization for session operations that share one live Letta session. */
export class SerialScheduler {
  private tail: Promise<void> = Promise.resolve();

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
