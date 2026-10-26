import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendTranscript, cutCapture, openCapture } from './use-voice-recorder.ts';

test('closes the AudioContext when recorder start fails', () => {
  let closes = 0;
  const context = {
    createAnalyser: () => ({ fftSize: 0 }),
    createMediaStreamSource: () => ({ connect() {} }),
    close: async () => {
      closes += 1;
    },
  } as unknown as AudioContext;
  const recorder = {
    start() {
      throw new Error('recorder unavailable');
    },
  } as unknown as MediaRecorder;

  assert.throws(() => openCapture({} as MediaStream, recorder, () => context), {
    message: 'recorder unavailable',
  });
  assert.equal(closes, 1);
});

test('a capture that starts keeps its AudioContext open', () => {
  let closes = 0;
  let started = 0;
  const node = { fftSize: 0 };
  const context = {
    createAnalyser: () => node,
    createMediaStreamSource: () => ({ connect: () => undefined }),
    close: async () => {
      closes += 1;
    },
  } as unknown as AudioContext;
  const recorder = {
    start: () => {
      started += 1;
    },
  } as unknown as MediaRecorder;

  const capture = openCapture({} as MediaStream, recorder, () => context);
  assert.equal(capture.context, context);
  assert.equal(capture.node, node);
  assert.equal(node.fftSize, 1024);
  assert.equal(started, 1);
  assert.equal(closes, 0);
});

test('auto-stop stops the recorder, releases the microphone and reports the cut', () => {
  const calls: string[] = [];
  const recording = {
    recorder: {
      state: 'recording',
      stop: () => calls.push('stop'),
    } as unknown as MediaRecorder,
    tooLong: false,
    tooLarge: false,
  };
  const cuts: string[] = [];

  cutCapture(
    recording,
    'duration',
    () => calls.push('release'),
    (reason) => cuts.push(reason)
  );

  assert.equal(recording.tooLong, true);
  assert.deepEqual(calls, ['stop', 'release']);
  assert.deepEqual(cuts, ['duration'], 'the UI leaves the recording state at the cut');
});

test('a size cut is reported as a size cut', () => {
  const cuts: string[] = [];
  const recording = {
    recorder: {
      state: 'inactive',
      stop: () => assert.fail('no stop when inactive'),
    } as unknown as MediaRecorder,
    tooLong: false,
    tooLarge: false,
  };
  cutCapture(
    recording,
    'size',
    () => undefined,
    (reason) => cuts.push(reason)
  );
  assert.equal(recording.tooLarge, true);
  assert.deepEqual(cuts, ['size']);
});

test('dictated text is joined to the composer text', () => {
  assert.equal(appendTranscript('', 'hello', 100), 'hello');
  assert.equal(appendTranscript('one  ', 'two', 100), 'one two');
});

test('refuses text beyond the turn text limit', () => {
  assert.equal(appendTranscript('', 'x'.repeat(101), 100), null);
  assert.equal(appendTranscript('a'.repeat(99), 'bcd', 100), null);
  assert.equal(appendTranscript('a'.repeat(96), 'bcd', 100), 'a'.repeat(96) + ' bcd');
});
