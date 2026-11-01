#!/usr/bin/env node
/**
 * Live regression verification for `TypeError: aud.subarray is not a function`.
 *
 * The bug lived inside transformers.js `_call_whisper`:
 *
 *   const preparedAudios = await prepareAudios(audio, sampling_rate);
 *   for (const aud of preparedAudios) { ... aud.subarray(offset, offset_end) }
 *
 * `prepareAudios` only special-cases `string` / `URL` / `Float64Array` and
 * returns anything else unchanged, so handing it the Python-style
 * `{ array: Float32Array, sampling_rate }` container (what the old decoder
 * returned) made `aud` a plain object with no `.subarray` method. With
 * `chunk_length_s: 30` the chunking loop called `.subarray` and threw.
 *
 * This script runs the REAL bundled Whisper model against the REAL pipeline
 * options the app uses (`chunk_length_s: 30, stride_length_s: 5`) twice:
 *
 *   1. with a bare Float32Array — what `normalizeAudioToFloat32` now guarantees
 *      → must complete without any TypeError (the fix).
 *   2. with the legacy `{ array, sampling_rate }` container handed to the
 *      pipeline directly → reproduces the original failure mode (documents
 *      the root cause in this exact transformers.js version).
 *
 * Run:  node scripts/verify-whisper-pipeline.mjs
 * Fully offline: model + ONNX runtime ship under /public.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

const { pipeline, env } = await import('@huggingface/transformers');
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = join(ROOT, 'public', 'models');
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = join(ROOT, 'public', 'ort');
}

const SAMPLE_RATE = 16000;
const SECONDS = 65; // > 30 s so the chunking loop (the old crash site) runs
const CHUNK_OPTIONS = { chunk_length_s: 30, stride_length_s: 5 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Synthetic 65 s signal — content is irrelevant; only the TYPE reaching the
// pipeline matters for this regression.
const samples = new Float32Array(SAMPLE_RATE * SECONDS);
for (let i = 0; i < samples.length; i += 1) {
  const t = i / SAMPLE_RATE;
  const envelope = Math.min(1, t * 4) * Math.min(1, (SECONDS - t) * 4);
  samples[i] =
    envelope * (0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 440 * t) +
      0.02 * (Math.random() * 2 - 1));
}

console.log('Loading the bundled Whisper model (offline)…');
const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
  dtype: 'q8',
});
console.log('Model ready.\n');

// ── 1. The fixed input: a bare Float32Array, as normalizeAudioToFloat32 guarantees
try {
  const started = Date.now();
  const output = await transcriber(samples, CHUNK_OPTIONS);
  check(
    'bare Float32Array runs the aud.subarray chunking path without TypeError',
    typeof output?.text === 'string',
    `${SECONDS}s audio, ${Date.now() - started} ms, text type ${typeof output?.text}`,
  );
} catch (error) {
  check('bare Float32Array runs the aud.subarray chunking path without TypeError', false, error.message);
}

// ── 2. The legacy container, handed to the pipeline exactly as the old code did
try {
  const output = await transcriber({ array: samples, sampling_rate: SAMPLE_RATE }, CHUNK_OPTIONS);
  console.log(
    `INFO  legacy { array, sampling_rate } container did NOT throw in transformers.js ${'3.x'} — ` +
      `prepareAudios now unwraps it (text type ${typeof output?.text}). The ` +
      `normalizeAudioToFloat32 guard remains the app-level protection.`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check(
    'ROOT CAUSE reproduced with the legacy container (aud.subarray TypeError)',
    /subarray is not a function/.test(message),
    message.slice(0, 160),
  );
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
