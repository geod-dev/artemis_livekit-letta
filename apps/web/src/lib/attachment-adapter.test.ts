import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TURN_ATTACHMENTS } from '@artemis/contracts/chat-types';
import { createAttachmentAdapter } from './attachment-adapter.ts';
import { MAX_ATTACHMENT_BYTES } from './attachments.ts';

/** Adds a file the way the composer does: consumes the adapter's stream and stores what it yields. */
async function addLikeComposer(
  adapter: ReturnType<typeof createAttachmentAdapter>,
  stored: unknown[],
  file: File
): Promise<void> {
  const result = adapter.add({ file });
  if (!(Symbol.asyncIterator in result)) throw new Error('expected the adapter to stream');
  for await (const attachment of result) stored.push(attachment);
}

const textFile = (name: string) => new File(['x'], name, { type: 'text/plain' });

test('rejects the 21st attachment, including one of a burst (a multi-file drop or paste)', async () => {
  const stored: unknown[] = [];
  const adapter = createAttachmentAdapter(() => stored.length);
  const files = Array.from({ length: MAX_TURN_ATTACHMENTS + 1 }, (_, i) => textFile(`f${i}.txt`));

  // Every add starts before any has landed in the composer, as a drop of 21 files does.
  const results = await Promise.allSettled(
    files.map((file) => addLikeComposer(adapter, stored, file))
  );

  assert.equal(stored.length, MAX_TURN_ATTACHMENTS);
  const refused = results.filter((result) => result.status === 'rejected');
  assert.equal(refused.length, 1);
  assert.equal(results.at(-1)?.status, 'rejected');
  assert.match(String((refused[0] as PromiseRejectedResult).reason), /at most 20 attachments/);
});

test('admits a file again once the composer holds fewer attachments', async () => {
  const stored: unknown[] = [];
  const adapter = createAttachmentAdapter(() => stored.length);
  await Promise.allSettled(
    Array.from({ length: MAX_TURN_ATTACHMENTS }, (_, i) =>
      addLikeComposer(adapter, stored, textFile(`f${i}.txt`))
    )
  );
  assert.equal(stored.length, MAX_TURN_ATTACHMENTS);

  stored.pop();
  await addLikeComposer(adapter, stored, textFile('again.txt'));
  assert.equal(stored.length, MAX_TURN_ATTACHMENTS);
});

test('a refused oversized file does not hold a slot', async () => {
  const stored: unknown[] = [];
  const adapter = createAttachmentAdapter(() => stored.length);
  const oversized = textFile('big.bin');
  Object.defineProperty(oversized, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });

  await assert.rejects(addLikeComposer(adapter, stored, oversized), /larger than/);
  await Promise.all(
    Array.from({ length: MAX_TURN_ATTACHMENTS }, (_, i) =>
      addLikeComposer(adapter, stored, textFile(`f${i}.txt`))
    )
  );
  assert.equal(stored.length, MAX_TURN_ATTACHMENTS);
});
