import type { IncidentType } from '../validation/constants.js';

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
 */
export function extractFromTranscript(transcript: string): ExtractionResult {
  const text = transcript.toLowerCase();
  const extracted: ExtractedData = {};

  // ── Incident type (first matching rule wins; most specific first) ────
  const rules: [IncidentType, RegExp][] = [
    ['CARDIAC_ARREST', /\b(cardiac|heart attack|pulse|cpr|collapsed|unconscious)\b/],
    ['VEHICLE_COLLISION', /\b(crash|collision|hit|accident|rear-ended|rammed|smashed)\b/],
    ['STRUCTURAL_COLLAPSE', /\b(collapse|collapsed building|cave.?in|debris|rubble)\b/],
    ['MASS_CASUALTY', /\b(mass casualty|multiple casualties|many injured|many wounded|stampede)\b/],
    ['EXPLOSION', /\b(explosion|exploded|blast|bomb|detonat)\b/],
    ['GAS_LEAK', /\b(gas leak|leaking gas|gas smell|smell of gas|lpg|carbon monoxide)\b/],
    ['FIRE', /\b(fire|flames|burning|smoke|blaze)\b/],
    ['ELECTROCUTION', /\b(electrocut|electric shock|live wire|high.?voltage)\b/],
    ['OBSTETRIC_EMERGENCY', /\b(pregnant|pregnancy|labour|labor|childbirth|contractions|water broke)\b/],
    ['STROKE', /\b(stroke|paralys|slurred speech|face droop|numbness|one side of the body)\b/],
    ['SEIZURE', /\b(seizure|convuls|epilep|fits)\b/],
    ['RESPIRATORY_DISTRESS', /\b(breathing|breathless|breath|asthma|suffocat|choking|inhalation)\b/],
    ['POISONING', /\b(poison|poisoning|overdose|swallowed|toxic|pesticide|snakebite)\b/],
    ['DROWNING', /\b(drown|drowning|underwater|water)\b/],
    ['BURN', /\b(burn|burns|scald|scalded)\b/],
    ['ASSAULT', /\b(stab|stabbed|gunshot|shot|assault|attacked|knife|machete)\b/],
    ['FALL_INJURY', /\b(fell|fall|fallen|dropped)\b/],
    ['MEDICAL_EMERGENCY', /\b(bleeding|chest pain|allergic|vomiting|fever|unwell|unconsciousness)\b/],
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
  };
  const digitMatch = text.match(/\b(\d{1,3})\b\s*(?:people|persons|victims|injured|passengers)/);
  const wordMatch = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b\s*(?:people|persons|victims)/);
  if (digitMatch) extracted.victimCount = Math.min(999, parseInt(digitMatch[1], 10));
  else if (wordMatch) extracted.victimCount = numberWords[wordMatch[1]];
  else extracted.victimCount = 1;

  // ── Location (text after near/at/on/intersection keywords) ───────────
  const locMatch =
    text.match(/\b(?:near|at|on|outside|intersection of|by)\s+([a-z0-9][^.,;!?]{3,80})/);
  if (locMatch) {
    // Title-case so assertions/UI show "Karol Bagh", not "karol bagh".
    const raw = locMatch[1]
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    extracted.location = raw;
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
