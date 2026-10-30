import { extractFromTranscript } from './voiceExtractionService.js';
import type { IncidentType, Priority } from '../validation/constants.js';

/**
 * Turns a transcript into the structured facts a dispatch decision needs.
 *
 * This sits on top of the existing `voiceExtractionService` (incident type,
 * victim count, confidence) rather than replacing it, so the rules that
 * existing reports already rely on keep working unchanged. What is added here
 * is the part the previous flow was missing: a *spoken* location, the
 * landmarks inside it, severity, and the operational hints a dispatcher reads.
 *
 * Everything is derived from the words that were actually said. Nothing is
 * inferred about a place the speaker never mentioned.
 */

export interface ExtractedEmergencyInformation {
  /** Maps onto Emergency.incidentType. */
  emergencyType: IncidentType;
  /** Narrative severity, independent of the transport priority. */
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Emergency.priority, derived from the existing severity rules. */
  priority: Priority;
  description: string;
  /** Number of injured people stated, or null when nothing was said. */
  injuredPeople: number | null;
  /** The place the caller named, verbatim apart from trimming. */
  spokenLocation: string | null;
  /** Recognisable landmark phrases inside the spoken location. */
  landmarks: string[];
  city: string | null;
  state: string | null;
  /** Short operational notes, e.g. "trapped", "not breathing". */
  dispatchHints: string[];
  confidence: number;
}

export interface ExtractionContext {
  /** City names present in the hospital network — read from MongoDB. */
  knownCities?: readonly string[];
  /** State names present in the hospital network — read from MongoDB. */
  knownStates?: readonly string[];
}

/** Longest preposition first so `in front of` wins over `in`. */
const LOCATION_PATTERNS: RegExp[] = [
  /\bintersection of\s+(.+)/i,
  /\b(?:in\s+front\s+of|across\s+from|opposite\s+to|next\s+to|close\s+to|beside|behind|nearby|near|outside|at)\s+(.+)/i,
  /\bon\s+(.+)/i,
  /\bin\s+(.+)/i,
  /\bby\s+(.+)/i,
];

/**
 * Connectors that end a place phrase. Without these, "near Rajwada Square and
 * two people are injured" would swallow the casualty report.
 */
const PLACE_CONNECTORS = [
  ' and ', ' but ', ' because ', ' however ', ' while ', ' when ', ' please ', ' kindly ',
  ' since ', ' so ', ' that ', ' which ', ' who ', ' with ', ' from ', ' as ', ' if ',
  ' send ', ' call ', ' help ', ' hurry ', ' quick', ' fast ', ' now ',
];

/**
 * Trailing words that are clearly the start of the next clause rather than part
 * of a place name.
 */
const PLACE_TAIL_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'be', 'been',
  'i', 'we', 'my', 'our', 'his', 'her', 'their', 'they', 'it', 'this', 'these',
  'someone', 'somebody', 'people', 'person', 'men', 'women', 'there', 'here',
  'ambulance', 'police', 'help', 'emergency', 'injured', 'injury', 'trapped',
  'bleeding', 'unconscious', 'dead', 'dying', 'need', 'needs', 'want', 'wants',
  'call', 'quickly', 'urgent', 'urgently', 'sir', 'madam', 'hello', 'there',
]);

/** Nouns that end a landmark phrase ("…Square", "…Road crossing"). */
const LANDMARK_NOUNS = [
  'square', 'road', 'street', 'marg', 'lane', 'crossing', 'junction', 'intersection',
  'market', 'bazaar', 'station', 'railway', 'airport', 'terminal', 'temple', 'mandir',
  'mosque', 'church', 'gurudwara', 'mall', 'hospital', 'clinic', 'dispensary',
  'school', 'college', 'university', 'bridge', 'park', 'garden', 'flyover', 'bypass',
  'expressway', 'highway', 'circle', 'chowk', 'nagar', 'colony', 'society',
  'apartment', 'apartments', 'tower', 'gate', 'plaza', 'complex', 'bus', 'metro',
  'court', 'bank', 'stadium', 'cinema', 'hotel', 'resort', 'village', 'town',
  'centre', 'center', 'bhawan', 'ghat', 'port', 'factory', 'plant', 'office',
  'sector', 'plot', 'chauraaha', 'chouraha', 'four', 'five', 'signal', 'post',
];

/** Phrases that raise severity regardless of incident type. */
const CRITICAL_PHRASES: RegExp[] = [
  /\bnot\s+breathing\b/,
  /\bstopped\s+breathing\b/,
  /\bno\s+pulse\b/,
  /\bunconscious\b/,
  /\bnot\s+moving\b/,
  /\bnot\s+responding\b/,
  /\bbleeding\s+(badly|heavily|severely)\b/,
  /\btrapped\b/,
  /\btrapped\s+under\b/,
  /\bmass\s+casualty\b/,
  /\bmultiple\s+casualt/,
  /\bstampede\b/,
  /\bexplosion\b/,
  /\bheart\s+attack\b/,
  /\bcardiac\b/,
  /\bchest\s+pain\b/,
  /\bchild\b/,
  /\bpregnant\b/,
  /\bdrowning\b/,
  /\bgunshot\b/,
  /\bstabbed\b/,
];

/** Phrases that mark urgency but not an immediate life threat. */
const URGENT_PHRASES: RegExp[] = [
  /\burgent/,
  /\bquick/,
  /\bhurry/,
  /\bimmediately\b/,
  /\bfast/,
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

function titleCase(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Cuts a captured place phrase at the first clause connector. */
function truncateAtConnector(value: string): string {
  let result = value;
  let changed = true;
  while (changed) {
    changed = false;
    const padded = ` ${result.toLowerCase()} `;
    for (const connector of PLACE_CONNECTORS) {
      const index = padded.indexOf(connector);
      if (index > 0) {
        result = result.slice(0, index);
        changed = true;
        break;
      }
    }
  }
  return result;
}

/** Drops trailing filler words ("… and are injured" → "…"). */
function trimTailWords(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (PLACE_TAIL_WORDS.has(last)) words.splice(words.length - 1, 1);
    else break;
  }
  return words.join(' ');
}

/** Strips leading articles and stray punctuation. */
function stripLeadingFiller(value: string): string {
  return value.replace(/^[\s,.;:]+/, '').replace(/^(?:the|a|an|some|any)\s+/i, '').trim();
}

function detectLandmarks(phrase: string): string[] {
  const words = phrase.split(/\s+/).filter(Boolean);
  const found: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!LANDMARK_NOUNS.includes(word)) continue;
    // A landmark is the noun plus up to two preceding capitalised tokens
    // ("Rajwada Square", "Vijay Nagar Square").
    let start = i;
    while (start > 0 && i - start < 2 && /^[A-Z]/.test(words[start - 1])) start -= 1;
    found.push(words.slice(start, i + 1).join(' '));
  }
  return [...new Set(found)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKnown(value: string, known: readonly string[] | undefined): string | null {
  if (!known?.length || !value) return null;
  const lowered = value.toLowerCase();
  const hit = known.find((candidate) => candidate && candidate.toLowerCase() === lowered);
  return hit ? titleCase(hit) : null;
}

export interface SpokenLocationResult {
  spokenLocation: string | null;
  landmarks: string[];
  city: string | null;
  state: string | null;
}

const SEVERITY_TO_PRIORITY: Record<ExtractedEmergencyInformation['severity'], Priority> = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
};

/** Incident types that need a trauma-capable destination by definition. */
const TRAUMA_TYPES: readonly IncidentType[] = [
  'VEHICLE_COLLISION', 'STRUCTURAL_COLLAPSE', 'EXPLOSION', 'MASS_CASUALTY', 'ASSAULT',
];

/** Incident types that need critical-care capability by definition. */
const CRITICAL_CARE_TYPES: readonly IncidentType[] = [
  'CARDIAC_ARREST', 'STROKE', 'RESPIRATORY_DISTRESS', 'DROWNING', 'OBSTETRIC_EMERGENCY',
];

/**
 * Severity rules, derived only from what the caller actually said. Kept in one
 * function so they stay configurable and testable instead of scattered across
 * the pipeline.
 */
export function deriveSeverity(
  emergencyType: IncidentType,
  loweredTranscript: string,
  injuredPeople: number | null,
): ExtractedEmergencyInformation['severity'] {
  if (CRITICAL_PHRASES.some((pattern) => pattern.test(loweredTranscript))) return 'CRITICAL';
  if (injuredPeople !== null && injuredPeople >= 5) return 'CRITICAL';
  if (CRITICAL_CARE_TYPES.includes(emergencyType)) return 'CRITICAL';
  if (injuredPeople !== null && injuredPeople >= 2) return 'HIGH';
  if (TRAUMA_TYPES.includes(emergencyType)) return 'HIGH';
  if (URGENT_PHRASES.some((pattern) => pattern.test(loweredTranscript))) return 'HIGH';
  return 'MEDIUM';
}

/** True when the incident needs a trauma-capable destination. */
export function requiresTraumaCapability(
  emergencyType: IncidentType,
  severity: string,
): boolean {
  return severity === 'CRITICAL' || TRAUMA_TYPES.includes(emergencyType);
}

/** True when the incident needs critical-care (ICU) capability. */
export function requiresCriticalCareCapability(severity: string): boolean {
  return severity === 'CRITICAL';
}

/**
 * Maps a transcript onto the structured facts a dispatch decision needs.
 *
 * The existing, tested `voiceExtractionService` still decides the incident
 * type, victim count and confidence, so existing reports stay consistent; what
 * is added here is the spoken location, landmarks, severity and dispatch hints
 * the previous flow was missing.
 */
export function extractEmergencyInformation(
  transcript: string,
  context: ExtractionContext = {},
): ExtractedEmergencyInformation {
  const text = transcript.trim();
  const lowered = text.toLowerCase();
  const { extractedData, confidence } = extractFromTranscript(text);
  const location = extractSpokenLocation(text, context);
  const injuredPeople = extractedData.victimCount ?? null;

  const dispatchHints: string[] = [];
  for (const pattern of [...CRITICAL_PHRASES, ...URGENT_PHRASES]) {
    const hit = pattern.exec(lowered);
    if (hit) dispatchHints.push(hit[0].trim());
  }

  const emergencyType = extractedData.incidentType ?? 'OTHER';
  const severity = deriveSeverity(emergencyType, lowered, injuredPeople);

  return {
    emergencyType,
    severity,
    priority: SEVERITY_TO_PRIORITY[severity],
    description: extractedData.description ?? text.slice(0, 300),
    injuredPeople,
    spokenLocation: location.spokenLocation ?? location.city,
    landmarks: location.landmarks,
    city: location.city,
    state: location.state,
    dispatchHints: [...new Set(dispatchHints)],
    confidence,
  };
}

export { NUMBER_WORDS };

/**
 * Extracts the place the caller actually named.
 *
 *   "Accident near Rajwada Square, Indore."      → `Rajwada Square, Indore`
 *   "Fire near Vijay Nagar Square in Indore, …"  → landmark `Vijay Nagar Square`, city `Indore`
 *   "Someone collapsed near Phoenix Citadel"     → `Phoenix Citadel`
 *   "Need ambulance near Rajwada"                → `Rajwada`
 *
 * When the caller named no place at all, every field is null. The caller must
 * then fall back to the device GPS or ask the user — it must never guess.
 */
export function extractSpokenLocation(
  transcript: string,
  context: ExtractionContext = {},
): SpokenLocationResult {
  const sentences = transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length === 0) {
    return { spokenLocation: null, landmarks: [], city: null, state: null };
  }

  for (const sentence of sentences) {
    for (const pattern of LOCATION_PATTERNS) {
      const match = pattern.exec(sentence);
      if (!match) continue;

      const trimmed = trimTailWords(stripLeadingFiller(truncateAtConnector(match[1])))
        .replace(/[\s,;:.!]+$/, '')
        .trim();
      if (trimmed.length < 3) continue;

      // "Rajwada Square, Indore" → landmark + city
      const segments = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
      let landmark = segments[0];
      let city: string | null = null;
      let state: string | null = null;

      if (segments.length > 1) {
        const tail = segments[segments.length - 1];
        const knownCity = matchesKnown(tail, context.knownCities);
        const knownState = matchesKnown(tail, context.knownStates);
        if (knownCity) city = knownCity;
        else if (knownState) state = knownState;
        // An unrecognised trailing segment is still the best city guess we
        // have; the geocoder decides whether it is real.
        else if (/^[A-Z][A-Za-z.'-]{2,}$/.test(tail)) city = titleCase(tail);
        landmark = segments.slice(0, -1).join(', ') || landmark;
      }

      // "Vijay Nagar Square in Indore" → landmark + inline city
      const inline = /^(.*?)\s+in\s+([A-Za-z][A-Za-z .'-]{2,40})$/.exec(landmark);
      if (inline) {
        const knownCity = matchesKnown(inline[2].trim(), context.knownCities);
        if (knownCity) {
          city = knownCity;
          landmark = inline[1].trim();
        } else if (!/\b(in|at|near|on)\b/i.test(inline[2])) {
          city = titleCase(inline[2].trim());
          landmark = inline[1].trim();
        }
      }

      landmark = landmark.replace(/[\s,;:.!]+$/, '').trim();
      if (!landmark) continue;

      return {
        spokenLocation: [landmark, city].filter(Boolean).join(', '),
        landmarks: detectLandmarks(landmark),
        city,
        state,
      };
    }
  }

  // No preposition matched, but the caller may still have named a place the
  // hospital network knows about.
  const mentioned = (known?: readonly string[]) =>
    known?.find(
      (candidate) => candidate && new RegExp(`\\b${escapeRegExp(candidate)}\\b`, 'i').test(transcript),
    ) ?? null;
  const cityFromText = mentioned(context.knownCities);
  const stateFromText = mentioned(context.knownStates);
  if (!cityFromText && !stateFromText) {
    return { spokenLocation: null, landmarks: [], city: null, state: null };
  }
  return {
    spokenLocation: null,
    landmarks: [],
    city: cityFromText ? titleCase(cityFromText) : null,
    state: stateFromText ? titleCase(stateFromText) : null,
  };
}

// __CONTINUE__
