/** Minimal typed pub/sub used across packages. Listeners never throw into publishers. */
export interface EventSource<E> {
  subscribe(listener: (event: E) => void): () => void;
}

export interface EventSink<E> {
  publish(event: E): void;
}
