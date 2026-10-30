#!/usr/bin/env node
/**
 * WebM/EBML structural inspector for stored voice recordings.
 *
 *   node scripts/inspect-webm.mjs <file.webm>
 *
 * Validates — without trusting the database — that a stored recording is a
 * real WebM container: EBML header, Segment, Info (Duration/Timecale),
 * Tracks (CodecID, audio track), and Clusters with timecodes. Prints safe
 * structural metadata only (no audio payloads).
 */
import { open, stat } from 'node:fs/promises';

function readVint(buf, pos) {
  // EBML varint: length = leading-zero count of first byte + 1.
  const first = buf[pos];
  if (first === undefined) throw new Error('EOF reading vint');
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len += 1; }
  if (len > 8) throw new Error('Invalid vint at ' + pos);
  let value = first & (mask - 1);
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + buf[pos + i];
  }
  // 1-byte all-ones means "unknown size".
  const unknown = (first & (mask - 1)) === mask - 1 && [...Array(len)].every((_, k) => k === 0 || buf[pos + k] === 0xff);
  return { value: unknown ? null : value, length: len };
}

function readId(buf, pos) {
  const first = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && !(first & mask)) { mask >>= 1; len += 1; }
  let id = 0;
  for (let i = 0; i < len; i += 1) id = id * 256 + buf[pos + i];
  return { id, length: len };
}

const ID_NAMES = {
  0x1a45dfa3: 'EBML', 0x18538067: 'Segment', 0x1549a966: 'Info',
  0x2ad7b1: 'TimecodeScale', 0x4489: 'Duration', 0x4461: 'DateUTC',
  0x1654ae6b: 'Tracks', 0xae: 'TrackEntry', 0x83: 'TrackType',
  0x86: 'CodecID', 0xe1: 'Audio', 0xb5: 'SamplingFrequency',
  0x9c: 'WriteFlag', 0x6d80: 'MuxingApp', 0x5741: 'WritingApp',
  0x1f43b675: 'Cluster', 0xe7: 'Timecode', 0xa3: 'SimpleBlock',
  0xa0: 'BlockGroup', 0x88: 'FlagID', 0x9f: 'CodecDelay',
  0x1c53bb6b: 'Cues', 0xbb: 'CuePoint', 0x536e: 'Name',
};

function floatBE(buf, len) {
  if (len === 4) return buf.readFloatBE(0);
  if (len === 8) return buf.readDoubleBE(0);
  return NaN;
}

async function inspect(path) {
  const info = await stat(path);
  const fh = await open(path, 'r');
  const buf = Buffer.alloc(info.size);
  await fh.read(buf, 0, info.size, 0);
  await fh.close();

  const report = {
    path, size: info.size,
    signature: buf.subarray(0, 4).toString('hex'),
    validEbmlHeader: buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3,
    looksLikeJsonOrHtml: /^\s*[{[]/.test(buf.toString('utf8', 0, 64)) || /^\s*</.test(buf.toString('utf8', 0, 64)),
    duration: null, timecodeScale: null, codecId: null, samplingFrequency: null,
    trackType: null, clusterCount: 0, firstClusterTimecode: null, lastClusterTimecode: null,
    simpleBlocks: 0, writingApp: null, muxingApp: null, truncated: false,
  };

  function walk(start, end, depth, onElement) {
    let pos = start;
    while (pos < end) {
      if (pos + 2 > end) break;
      const idRead = readId(buf, pos);
      const sizeRead = readVint(buf, pos + idRead.length);
      const headerLen = idRead.length + sizeRead.length;
      const contentStart = pos + headerLen;
      const size = sizeRead.value;
      const contentEnd = size === null ? end : Math.min(contentStart + size, end);
      if (contentStart > end) { report.truncated = true; break; }
      onElement(idRead.id, contentStart, contentEnd, size);
      pos = contentEnd;
      if (size === null) break;
    }
    return pos;
  }

  // Top level: EBML header + Segment.
  walk(0, buf.length, 0, (id, start, end) => {
    if (id === 0x18538067) {
      walk(start, end, 1, (sid, s, e) => {
        if (sid === 0x1549a966) { // Info
          walk(s, e, 2, (iid, is, ie) => {
            if (iid === 0x4489) report.duration = floatBE(buf.subarray(is, ie), ie - is);
            if (iid === 0x2ad7b1) report.timecodeScale = Number(buf.readUIntBE(is, Math.min(ie - is, 6)));
            if (iid === 0x5741) report.writingApp = buf.toString('utf8', is, ie);
            if (iid === 0x6d80) report.muxingApp = buf.toString('utf8', is, ie);
          });
        } else if (sid === 0x1654ae6b) { // Tracks
          walk(s, e, 2, (tid, ts, te) => {
            if (tid !== 0xae) return;
            walk(ts, te, 3, (eid, es, ee) => {
              if (eid === 0x83) report.trackType = buf.readUIntBE(es, ee - es);
              if (eid === 0x86) report.codecId = buf.toString('utf8', es, ee);
              if (eid === 0xe1) {
                walk(es, ee, 4, (aid, as, ae) => {
                  if (aid === 0xb5) report.samplingFrequency = floatBE(buf.subarray(as, ae), ae - as);
                });
              }
            });
          });
        } else if (sid === 0x1f43b675) { // Cluster
          report.clusterCount += 1;
          walk(s, e, 2, (cid, cs, ce) => {
            if (cid === 0xe7) {
              const tc = Number(buf.readUIntBE(cs, ce - cs));
              if (report.firstClusterTimecode === null) report.firstClusterTimecode = tc;
              report.lastClusterTimecode = tc;
            }
            if (cid === 0xa3) report.simpleBlocks += 1;
          });
        }
      });
    }
  });

  // MediaRecorder live captures often omit Duration; derive from clusters.
  const scaleNs = report.timecodeScale ?? 1_000_000;
  const derived = report.lastClusterTimecode !== null
    ? (report.lastClusterTimecode * scaleNs) / 1e9
    : null;
  report.clusterDerivedSeconds = derived === null ? null : Math.round(derived * 10) / 10;
  console.log(JSON.stringify(report, null, 2));
}

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/inspect-webm.mjs <file.webm>');
  process.exit(1);
}
await inspect(target);
