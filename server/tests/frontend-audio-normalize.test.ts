import { describe, expect, it } from 'vitest';
import {
  AudioNormalizeError,
  buildAudioFilename,
  describeAudio,
  extensionForMimeType,
  isTypedArrayLike,
  normalizeAudioToBytes,
  normalizeAudioToBytesAsync,
} from '../../src/lib/audioNormalize.js';
import { AudioShapeError, normalizeAudioToFloat32 } from '../../src/lib/transcribeAudio.js';

/**
 * Browser-side audio pipeline tests.
 *
 * These import the shipped client modules from `src/lib`. The server tsconfig
 * uses NodeNext resolution and has no DOM lib, so — exactly like
 * `frontend-rbac.test.ts` — this file is excluded from `tsc --noEmit` and is
 * typechecked by the client project instead. vitest still RUNS it.
 *
 * The load-bearing cases here are the regressions for
 * `TypeError: aud.subarray is not a function`.
 */

describe('browser audio normalization', () => {
  it('normalizes Buffer, Uint8Array, ArrayBuffer and base64', () => {
    expect([...normalizeAudioToBytes(Buffer.from([4, 5]))]).toEqual([4, 5]);
    expect([...normalizeAudioToBytes(new Uint8Array([6]))]).toEqual([6]);
    expect([...normalizeAudioToBytes(new Uint8Array([7, 8]).buffer)]).toEqual([7, 8]);
    expect([...normalizeAudioToBytes(Buffer.from([9]).toString('base64'))]).toEqual([9]);
    expect([
      ...normalizeAudioToBytes(`data:audio/webm;base64,${Buffer.from([10]).toString('base64')}`),
    ]).toEqual([10]);
  });

  it('honours the byteOffset of a sliced typed array', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = backing.subarray(2, 5);
    expect([...normalizeAudioToBytes(view)]).toEqual([3, 4, 5]);
  });

  it('rejects invalid audio input with a typed, showable error', () => {
    expect(() => normalizeAudioToBytes(null)).toThrow(AudioNormalizeError);
    expect(() => normalizeAudioToBytes('')).toThrow(/empty/i);
    expect(() => normalizeAudioToBytes({ nope: 1 } as never)).toThrow(AudioNormalizeError);
  });

  it('reads a Blob asynchronously and rejects an empty one', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
    expect([...(await normalizeAudioToBytesAsync(blob))]).toEqual([1, 2, 3, 4]);
    await expect(
      normalizeAudioToBytesAsync(new Blob([], { type: 'audio/webm' })),
    ).rejects.toThrow(AudioNormalizeError);
  });

  it('unwraps a { buffer, mimetype } multipart part', () => {
    const part = { buffer: new Uint8Array([7, 8]), mimetype: 'audio/webm' };
    expect([...normalizeAudioToBytes(part)]).toEqual([7, 8]);
  });

  it('describes an audio value as metadata only, never samples', () => {
    const shape = describeAudio(new Uint8Array([1, 2, 3]));
    expect(shape).toMatchObject({
      constructorName: 'Uint8Array', isTypedArray: true, isArrayBuffer: false, byteLength: 3,
    });
    expect(shape).not.toHaveProperty('data');
    expect(describeAudio(null).constructorName).toBe('null');
    expect(isTypedArrayLike(new Float32Array(1))).toBe(true);
    expect(isTypedArrayLike({})).toBe(false);
  });

  it('derives the container extension from the real MIME type', () => {
    expect(extensionForMimeType('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMimeType('audio/mp4')).toBe('m4a');
    expect(extensionForMimeType('application/octet-stream')).toBe('bin');
    expect(buildAudioFilename('audio/ogg', 42)).toBe('voice-emergency-42.ogg');
  });
});

describe('REGRESSION: aud.subarray is not a function', () => {
  it('unwraps the Python-style { array, sampling_rate } container', () => {
    // This is the exact value that used to reach `aud.subarray(...)` inside
    // transformers.js `_call_whisper` and threw a TypeError.
    const pythonStyle = { array: new Float32Array([0.1, 0.2, 0.3]), sampling_rate: 16000 };
    const { samples, samplingRate } = normalizeAudioToFloat32(pythonStyle);

    expect(samples).toBeInstanceOf(Float32Array);
    expect(samples.length).toBe(3);
    expect(samplingRate).toBe(16000);
    // The call that used to throw.
    expect(() => samples.subarray(0, 2)).not.toThrow();
    expect(samples.subarray(0, 2).length).toBe(2);
  });

  it('passes a bare Float32Array through, which has .subarray', () => {
    const { samples } = normalizeAudioToFloat32(new Float32Array([0.5, 0.6]));
    expect(samples).toBeInstanceOf(Float32Array);
    expect(typeof samples.subarray).toBe('function');
  });

  it('narrows Float64Array and other typed arrays', () => {
    expect(normalizeAudioToFloat32(new Float64Array([1, 2])).samples)
      .toBeInstanceOf(Float32Array);
    expect(normalizeAudioToFloat32(new Int16Array([3, 4])).samples.length).toBe(2);
    expect(
      normalizeAudioToFloat32(new Float32Array([1, 2]).buffer).samples,
    ).toBeInstanceOf(Float32Array);
  });

  it('rejects a non-array container with a clear error, not a TypeError', () => {
    expect(() => normalizeAudioToFloat32({ nope: true } as never)).toThrow(AudioShapeError);
    expect(() => normalizeAudioToFloat32(null)).toThrow(AudioShapeError);
    expect(() => normalizeAudioToFloat32('a string')).toThrow(AudioShapeError);
  });

  it('never returns a value without .subarray', () => {
    const inputs = [
      new Float32Array([1]),
      new Float64Array([1]),
      { array: new Float32Array([1]), sampling_rate: 16000 },
      new Float32Array([1, 2]).buffer,
    ];
    for (const input of inputs) {
      expect(typeof normalizeAudioToFloat32(input as never).samples.subarray).toBe('function');
    }
  });
});
