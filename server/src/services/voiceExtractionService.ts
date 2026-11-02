import type { IncidentType } from '../validation/constants.js';
import {
  normalizeExtractionText,
  detectGwaliorLocation,
} from './hindiNormalizationService.js';

export interface ExtractedData {
  incidentType?: IncidentType;
  location?: string;
  victimCount?: number;
  description?: string;
}

export interface ExtractionResult {
  extractedData: ExtractedData;
  confidence: number; // 0–100
}

/**
 * Lightweight deterministic "AI" extraction from a voice transcript.
 * Rule-based keyword matching — no external model calls, fully testable.
 * Confidence scales with how many fields could be extracted.
 *
 * Supports English, Devanagari Hindi, Romanized Hindi, and Hinglish.
 */
export function extractFromTranscript(transcript: string): ExtractionResult {
  const normalized = normalizeExtractionText(transcript);
  const text = normalized.toLowerCase();
  const extracted: ExtractedData = {};

  // ── Incident type (first matching rule wins; prioritized by event context) ────
  const rules: [IncidentType, RegExp][] = [
    // 1. Explicit Road Accidents & Vehicle Collisions (High Priority context)
    [
      'VEHICLE_COLLISION',
      /\b(crash|collision|collided|hit|accident|road\s*accident|traffic\s*accident|vehicle\s*accident|rear-ended|rammed|smashed|run\s*over|overturned|skidded|durgaatna|durghatna|durhath|sadak\s*durghatna|takkar|palat|gadi\s*takrayi|car\s*takkar)\b|पलट|दुर्घटना|सड़क\s*दुर्घटना|टक्कर|एक्सीडेंट/i,
    ],
    // 2. High-Severity Catastrophic Events
    [
      'MASS_CASUALTY',
      /\b(mass casualty|multiple casualties|many injured|many wounded|stampede)\b/i,
    ],
    [
      'EXPLOSION',
      /\b(explosion|exploded|blast|bomb|detonat)\b/i,
    ],
    // 3. Explicit Medical Emergencies (Explicit cardiac arrest indicators required)
    [
      'CARDIAC_ARREST',
      /\b(cardiac(?:\s*arrest)?|heart\s*attack|chest\s*pain|cpr|no\s*pulse|stopped\s*pulse|without\s*pulse|pulse\s*(?:ruk|nahi)|dil\s*ka\s*d[ao]ura|dilka\s*dora)\b|हार्ट\s*अटैक|दिल\s*का\s*दौरा|सीने\s*में\s*दर्द|नब्ज\s*नहीं/i,
    ],
    [
      'FIRE',
      /\b(fire|flames|burning|smoke|blaze|aag\b|aag\s*lag)\b|धुआं|आग|जल\s*रहा/i,
    ],
    [
      'STRUCTURAL_COLLAPSE',
      /\b(collapsed\s*building|building\s*collaps|structural\s*collaps|bridge\s*collaps|roof\s*collaps|wall\s*collaps|cave.?in|debris|rubble)\b|इमारत\s*गिर|दीवार\s*गिर|मलबा/i,
    ],
    [
      'STROKE',
      /\b(stroke|paralys|slurred speech|face droop|numbness|one side of the body)\b/i,
    ],
    [
      'SEIZURE',
      /\b(seizure|convuls|epilep|fits)\b/i,
    ],
    [
      'OBSTETRIC_EMERGENCY',
      /\b(pregnant|pregnancy|labour|labor|childbirth|contractions|water broke)\b/i,
    ],
    [
      'POISONING',
      /\b(poison|poisoning|overdose|swallowed|toxic|pesticide|snakebite)\b/i,
    ],
    [
      'DROWNING',
      /\b(drown|drowning|underwater|water)\b/i,
    ],
    [
      'ELECTROCUTION',
      /\b(electrocut|electric shock|live wire|high.?voltage)\b/i,
    ],
    [
      'GAS_LEAK',
      /\b(gas leak|leaking gas|gas smell|smell of gas|lpg|carbon monoxide)\b/i,
    ],
    [
      'ASSAULT',
      /\b(stab|stabbed|gunshot|shot|assault|attacked|knife|machete)\b/i,
    ],
    // 4. Secondary Symptom / Trauma Emergencies
    [
      'RESPIRATORY_DISTRESS',
      /\b(respiratory|breathing|breathless|breath|asthma|suffocat|choking|inhalation|sans\s*l[ea]hne|sans\s*lene|takleev|takleef)\b|सांस\s*लेने|सांस\s*फूल|दम\s*घुट/i,
    ],
    [
      'BURN',
      /\b(burn|burns|scald|scalded)\b/i,
    ],
    [
      'FALL_INJURY',
      /\b(fell|fall|fallen|dropped)\b/i,
    ],
    [
      'MEDICAL_EMERGENCY',
      /\b(head\s*injury|chot|ghayal|ghyal|ghaial|trauma|bleeding\s*heavily|bleeding|allergic|vomiting|fever|unwell|unconsciousness|unconscious|fainted|collapsed|not\s*responding|behosh|behush|khoon|dard)\b|गंभीर\s*चोट|सिर\s*में\s*चोट|रक्तस्राव|दर्द|खून|बेहोश|बेहोशी|अचेत/i,
    ],
  ];
  for (const [type, re] of rules) {
    if (re.test(text)) {
      extracted.incidentType = type;
      break;
    }
  }
  if (!extracted.incidentType) extracted.incidentType = 'OTHER';

  // ── Victim count ─────────────────────────────────────────────────────
  const numberWords: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5,
    che: 6, chhah: 6, saat: 7, aath: 8, nau: 9, das: 10,
    'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5,
    'छह': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  };
  const digitMatch = text.match(
    /\b(\d{1,3})\b\s*(?:people|persons|victims|injured|passengers|log|lough|yatri|ghayal|घायल|लोग|यात्री)/i,
  );
  const wordMatch = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|ek|do|teen|char|chaar|paanch|panch|che|saat|aath|nau|das)\b\s*(?:people|persons|victims|injured|passengers|log|lough|yatri|ghayal)|(एक|दो|तीन|चार|पांच|छह|सात|आठ|नौ|दस)\s*(?:लोग|यात्री|घायल)/i,
  );
  if (digitMatch) extracted.victimCount = Math.min(999, parseInt(digitMatch[1], 10));
  else if (wordMatch) {
    const rawWord = (wordMatch[1] ?? wordMatch[2] ?? '').toLowerCase().trim();
    extracted.victimCount = numberWords[rawWord] ?? 1;
  } else extracted.victimCount = 1;

  // ── Location ─────────────────────────────────────────────────────────
  const gwaliorLoc = detectGwaliorLocation(transcript);
  if (gwaliorLoc.landmark) {
    extracted.location = gwaliorLoc.formattedLocation ?? gwaliorLoc.landmark;
  } else {
    const locMatch =
      text.match(/\b(?:near|at|on|outside|intersection of|by)\s+([a-z0-9][^.,;!?]{3,80})/i);
    if (locMatch) {
      // Title-case so assertions/UI show "Karol Bagh", not "karol bagh".
      const raw = locMatch[1]
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      extracted.location = raw;
    }
  }

  // ── Description: first sentence, capped ──────────────────────────────
  const firstSentence = transcript.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (firstSentence) extracted.description = firstSentence.slice(0, 300);

  // ── Confidence: base + per-field evidence ────────────────────────────
  let confidence = 55;
  if (extracted.incidentType !== 'OTHER') confidence += 15;
  if (extracted.location) confidence += 15;
  if (digitMatch || wordMatch) confidence += 10;
  if (transcript.length > 60) confidence += 5;
  confidence = Math.min(96, confidence);

  return { extractedData: extracted, confidence };
}
