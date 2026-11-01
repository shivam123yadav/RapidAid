#!/usr/bin/env node
/**
 * Speech Recognition Reliability Benchmark (RapidAid Phase 1)
 *
 * Evaluates real recorded human speech fixtures across:
 * - English emergency report (en-US)
 * - Indian-accented English (en-IN)
 * - Hindi emergency report (hi-IN)
 * - Gwalior and local landmark names (Maharaj Bada, Phool Bagh, Hazira Chowk, Morar, Deendayal Nagar)
 * - Vehicle accident and medical emergency terminology
 *
 * Computes:
 * - Word Error Rate (WER) using word-level Levenshtein distance
 * - Location Extraction Accuracy
 * - Incident Classification Accuracy
 * - Inference Latency (ms) and Memory consumption
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const { pipeline, env } = await import('@huggingface/transformers');

// Emergency domain initial prompt to assist Whisper decoder without substituting text
export const EMERGENCY_INITIAL_PROMPT =
  'Emergency report: road accident, vehicle collision, ambulance needed, hospital, patient, unconscious, bleeding, Gwalior, Indore, Delhi, Maharaj Bada, Phool Bagh, Hazira, Morar, Deendayal Nagar, सड़क दुर्घटना, घायल, एम्बुलेंस, अस्पताल, बेहोश, दिल का दौरा';

/** Word-level Levenshtein distance for WER calculation */
export function calculateWER(reference, hypothesis) {
  const normalize = (s) =>
    (s || '')
      .toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'।]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const refWords = normalize(reference).split(' ').filter(Boolean);
  const hypWords = normalize(hypothesis).split(' ').filter(Boolean);

  if (refWords.length === 0) {
    return hypWords.length === 0 ? 0 : 1.0;
  }
  if (hypWords.length === 0) {
    return 1.0;
  }

  const d = Array.from({ length: refWords.length + 1 }, () =>
    new Array(hypWords.length + 1).fill(0),
  );

  for (let i = 0; i <= refWords.length; i++) d[i][0] = i;
  for (let j = 0; j <= hypWords.length; j++) d[0][j] = j;

  for (let i = 1; i <= refWords.length; i++) {
    for (let j = 1; j <= hypWords.length; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        d[i][j] = d[i - 1][j - 1];
      } else {
        d[i][j] = Math.min(
          d[i - 1][j] + 1, // deletion
          d[i][j - 1] + 1, // insertion
          d[i - 1][j - 1] + 1, // substitution
        );
      }
    }
  }

  const distance = d[refWords.length][hypWords.length];
  return Math.min(1.0, distance / refWords.length);
}

/** Reads a 16 kHz 16-bit mono WAV into Float32Array */
export function readWav16kMono(filePath) {
  const buf = readFileSync(filePath);
  // Find 'data' chunk
  let offset = 12;
  while (offset < buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const pcmOffset = offset + 8;
      const sampleCount = Math.floor(chunkSize / 2);
      const int16 = new Int16Array(buf.buffer, buf.byteOffset + pcmOffset, sampleCount);
      const float32 = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        float32[i] = int16[i] / 32768.0;
      }
      return float32;
    }
    offset += 8 + chunkSize;
  }
  throw new Error(`No data chunk found in WAV: ${filePath}`);
}

/** Audio amplitude normalization (boost low signals safely up to 0.95 peak) */
export function normalizeAudioAmplitude(samples, targetPeak = 0.95) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak === 0 || peak >= targetPeak) return samples;
  const factor = targetPeak / peak;
  const normalized = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    normalized[i] = samples[i] * factor;
  }
  return normalized;
}

async function benchmarkModel(modelId, manifest, options = {}) {
  console.log(`\n======================================================`);
  console.log(`Benchmarking model: ${modelId}`);
  console.log(`======================================================`);

  const tLoadStart = Date.now();
  const transcriber = await pipeline('automatic-speech-recognition', modelId, {
    dtype: 'q8',
  });
  const loadTimeMs = Date.now() - tLoadStart;
  console.log(`Model ${modelId} loaded in ${loadTimeMs} ms.`);

  const results = [];
  let totalRefWords = 0;
  let totalDistance = 0;
  let totalInferenceMs = 0;
  let correctLocations = 0;
  let correctIncidents = 0;

  // Dynamically import backend extraction logic for measuring extraction accuracy
  const { extractEmergencyInformation } = await import(
    '../server/dist/services/emergencyExtractionService.js'
  );
  const { calculateNormalizedErrorRates, detectGwaliorLocation, devanagariToRomanized } = await import(
    '../server/dist/services/hindiNormalizationService.js'
  );

  for (const item of manifest) {
    const wavPath = join(ROOT, 'fixtures', 'speech', item.file);
    const rawAudio = readWav16kMono(wavPath);
    const audio = normalizeAudioAmplitude(rawAudio);

    const transcribeOptions = {
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      ...(item.language ? { language: item.language } : {}),
      ...(options.useInitialPrompt ? { initial_prompt: EMERGENCY_INITIAL_PROMPT } : {}),
    };

    const t0 = Date.now();
    const output = await transcriber(audio, transcribeOptions);
    const inferenceMs = Date.now() - t0;
    totalInferenceMs += inferenceMs;

    const transcript = (typeof output?.text === 'string' ? output.text : '').trim();
    const rawWer = Number((calculateWER(item.reference_text, transcript) * 100).toFixed(1));
    const { wer: normWer, cer } = calculateNormalizedErrorRates(
      item.reference_text,
      transcript,
    );

    // Extraction evaluation
    const extracted = extractEmergencyInformation(transcript, {
      knownCities: ['Gwalior', 'Indore', 'Delhi', 'New Delhi', 'Bhopal', 'Jabalpur'],
    });

    // Check location accuracy (handling both English and Devanagari Hindi expected locations)
    const expectedLocLower = item.expected_location.toLowerCase();
    const extractedLoc = (extracted.spokenLocation || '').toLowerCase();
    const expectedLandmark = detectGwaliorLocation(item.expected_location);
    const keyLandmark = expectedLocLower.split(/,/)[0].trim();
    const romanizedExpectedKey = devanagariToRomanized(keyLandmark).toLowerCase();
    const locationFound =
      Boolean(extracted.spokenLocation) &&
      (extractedLoc.includes(keyLandmark) ||
        (expectedLandmark && expectedLandmark.landmark && extractedLoc.includes(expectedLandmark.landmark.toLowerCase())) ||
        extractedLoc.includes(romanizedExpectedKey) ||
        romanizedExpectedKey.split(/\s+/).some((w) => w.length > 3 && extractedLoc.includes(w)));
    if (locationFound) correctLocations++;

    // Check incident classification accuracy
    const expectedIncident = item.expected_incident;
    const classifiedIncident = extracted.emergencyType;
    const incidentCorrect = classifiedIncident === expectedIncident;
    if (incidentCorrect) correctIncidents++;

    console.log(`\n[${item.id}] ${item.category}`);
    console.log(`  Audio Duration: ${item.duration_seconds}s | Latency: ${inferenceMs}ms`);
    console.log(`  Reference:   "${item.reference_text}"`);
    console.log(`  Hypothesis:  "${transcript}"`);
    console.log(`  Spoken Location: "${extracted.spokenLocation || 'none'}" (Expected: "${item.expected_location}") -> ${locationFound ? 'PASS' : 'FAIL'}`);
    console.log(`  Raw WER: ${rawWer}% | Norm WER: ${normWer}% | CER: ${cer}% | Incident: ${classifiedIncident} (Expected: ${expectedIncident}) -> ${incidentCorrect ? 'PASS' : 'FAIL'}`);

    results.push({
      id: item.id,
      category: item.category,
      language: item.language,
      duration_seconds: item.duration_seconds,
      inference_ms: inferenceMs,
      reference: item.reference_text,
      hypothesis: transcript,
      raw_wer: rawWer,
      normalized_wer: normWer,
      cer: cer,
      spoken_location: extracted.spokenLocation,
      location_found: locationFound,
      expected_incident: expectedIncident,
      classified_incident: classifiedIncident,
      incident_correct: incidentCorrect,
    });
  }

  const avgRawWER = Number((results.reduce((acc, r) => acc + r.raw_wer, 0) / results.length).toFixed(1));
  const avgNormalizedWER = Number((results.reduce((acc, r) => acc + r.normalized_wer, 0) / results.length).toFixed(1));
  const avgCER = Number((results.reduce((acc, r) => acc + r.cer, 0) / results.length).toFixed(1));
  const locationAccuracy = Number(((correctLocations / results.length) * 100).toFixed(1));
  const incidentAccuracy = Number(((correctIncidents / results.length) * 100).toFixed(1));
  const avgInferenceMs = Math.round(totalInferenceMs / results.length);

  // Measure memory
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMb = Math.round(mem.rss / 1024 / 1024);

  const summary = {
    modelId,
    loadTimeMs,
    avgRawWER,
    avgNormalizedWER,
    avgCER,
    locationAccuracy,
    incidentAccuracy,
    avgInferenceMs,
    heapUsedMb,
    rssMb,
    results,
  };

  console.log(`\n--- SUMMARY for ${modelId} ---`);
  console.log(`Average Raw WER: ${avgRawWER}% | Average Normalized WER: ${avgNormalizedWER}% | Average CER: ${avgCER}%`);
  console.log(`Location Extraction Accuracy: ${locationAccuracy}% (${correctLocations}/${results.length})`);
  console.log(`Incident Classification Accuracy: ${incidentAccuracy}% (${correctIncidents}/${results.length})`);
  console.log(`Average Inference Time: ${avgInferenceMs} ms`);
  console.log(`Heap Used: ${heapUsedMb} MB | RSS: ${rssMb} MB`);

  return summary;
}

async function main() {
  const manifestPath = join(ROOT, 'fixtures', 'speech', 'benchmark-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  console.log(`Loaded benchmark manifest with ${manifest.length} fixtures.`);

  // 1. Benchmark whisper-tiny (Multilingual)
  const tinySummary = await benchmarkModel('Xenova/whisper-tiny', manifest, {
    useInitialPrompt: true,
  });

  // 2. Benchmark whisper-base (Multilingual)
  const baseSummary = await benchmarkModel('Xenova/whisper-base', manifest, {
    useInitialPrompt: true,
  });

  // 3. Save comprehensive comparison report
  const report = {
    timestamp: new Date().toISOString(),
    fixturesCount: manifest.length,
    models: {
      'Xenova/whisper-tiny': tinySummary,
      'Xenova/whisper-base': baseSummary,
    },
    comparison: {
      tiny: {
        wer: tinySummary.avgWER,
        locationAccuracy: tinySummary.locationAccuracy,
        incidentAccuracy: tinySummary.incidentAccuracy,
        avgInferenceMs: tinySummary.avgInferenceMs,
        rssMb: tinySummary.rssMb,
      },
      base: {
        wer: baseSummary.avgWER,
        locationAccuracy: baseSummary.locationAccuracy,
        incidentAccuracy: baseSummary.incidentAccuracy,
        avgInferenceMs: baseSummary.avgInferenceMs,
        rssMb: baseSummary.rssMb,
      },
    },
  };

  const reportPath = join(ROOT, 'fixtures', 'speech', 'benchmark-results.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nBenchmark completed! Full results saved to ${reportPath}`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
