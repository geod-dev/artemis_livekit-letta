/** A fork is usable and visible even if archiving its source fails upstream. */
export class RecoverableForkArchiveError<T> extends Error {
  constructor(readonly conversation: T, readonly stage: 'routing' | 'archive', options?: ErrorOptions) {
    super('The fork was created, but its source could not be safely retired', options);
    this.name = 'RecoverableForkArchiveError';
  }
}

/** Persist the callback route before the provider archives the source. */
export async function archiveForkWithRouting<T>(
  conversation: T,
  installRouting: () => Promise<void>,
  archiveSource: () => Promise<unknown>
): Promise<void> {
  let stage: 'routing' | 'archive' = 'routing';
  try {
    await installRouting();
    stage = 'archive';
    await archiveSource();
  } catch (error) {
    throw new RecoverableForkArchiveError(conversation, stage, { cause: error });
  }
}
