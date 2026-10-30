#!/usr/bin/env node
/**
 * Bundles the free Whisper speech-to-text model + ONNX runtime into the app:
 *   public/models/Xenova/whisper-tiny.en/  model + tokenizer (~42 MB)
 *   public/ort/                             onnxruntime-web wasm   (~42 MB)
 *
 * Vite copies public/ into dist/ on build, so the Voice page transcribes
 * fully offline with zero runtime downloads. Idempotent — existing files
 * are skipped unless --force is passed. `--optional` downgrades failures to
 * a warning (used by postinstall so installs never hard-fail when offline).
 *
 * Run: node scripts/sync-voice-model.mjs [--force] [--optional]
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODEL_ID = 'Xenova/whisper-tiny.en';
const MODEL_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main/`;
const MODEL_DIR = join(ROOT, 'public', 'models', ...MODEL_ID.split('/'));
const ORT_DIR = join(ROOT, 'public', 'ort');
const ORT_DIST = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist');

/** Exact file set consumed by `dtype: 'q8'` (verified by the offline test). */
const MODEL_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'generation_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

const force = process.argv.includes('--force');
const optional = process.argv.includes('--optional');

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${file}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let buf;
  if (res.body && total > 5 * 1024 * 1024) {
    // Stream large files with coarse progress so slow links aren't silent.
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    let mark = 25;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total && Math.floor((loaded / total) * 100) >= mark) {
        console.log(`    ${file}: ${mark}%`);
        mark += 25;
      }
    }
    buf = Buffer.concat(chunks);
  } else {
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (buf.length === 0) throw new Error(`Empty download: ${file}`);
  await mkdir(dirname(join(MODEL_DIR, file)), { recursive: true });
  await writeFile(join(MODEL_DIR, file), buf);
  return `${(buf.length / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const missingOrt = [];
  for (const name of ORT_FILES) {
    if (!(await exists(join(ORT_DIST, name)))) missingOrt.push(name);
  }
  if (missingOrt.length) {
    throw new Error(`@huggingface/transformers not installed (${missingOrt.join(', ')} missing) — run npm install first.`);
  }

  console.log('Bundling voice model (free Whisper) into public/ …');
  for (const file of MODEL_FILES) {
    if (!force && (await exists(join(MODEL_DIR, file)))) {
      console.log(`  ${file.padEnd(45)} kept`);
      continue;
    }
    const info = await download(`${MODEL_BASE}${file}`, file);
    console.log(`  ${file.padEnd(45)} ${info}`);
  }
  for (const name of ORT_FILES) {
    if (!force && (await exists(join(ORT_DIR, name)))) {
      console.log(`  ${name.padEnd(45)} kept`);
      continue;
    }
    await mkdir(ORT_DIR, { recursive: true });
    await copyFile(join(ORT_DIST, name), join(ORT_DIR, name));
    console.log(`  ${name.padEnd(45)} copied from node_modules`);
  }
  console.log('Voice model ready — transcription works fully offline.');
}

main().catch((err) => {
  if (optional) {
    console.warn(`[prepare:voice-model] skipped: ${err.message}`);
    process.exit(0);
  }
  console.error(`[prepare:voice-model] FAILED: ${err.message}`);
  process.exit(1);
});
