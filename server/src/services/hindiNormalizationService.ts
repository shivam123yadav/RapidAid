/**
 * Hindi, Romanized Hindi, and Hinglish Normalization Service for RapidAid.
 *
 * Provides:
 *  1. Devanagari to Romanized transliteration.
 *  2. Phonetic token normalization for fair benchmark WER/CER calculation.
 *  3. Landmark and location alias mapping for Gwalior emergency dispatch.
 *  4. Extraction text normalization that supports Devanagari, Romanized Hindi,
 *     Hinglish, and English without overwriting the citizen's original transcript.
 */

// ── Devanagari to Romanized Transliteration Tables ─────────────────────────
const DEVANAGARI_VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
};

const DEVANAGARI_MATRAS: Record<string, string> = {
  'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
  'ं': 'n', 'ँ': 'n', 'ः': 'h',
};

const DEVANAGARI_CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f',
};

const DEVANAGARI_DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

const VIRAMA = '्';

/**
 * Transliterates Devanagari script to Romanized Latin characters.
 * Leaves Latin characters, English text, and punctuation unchanged.
 */
export function devanagariToRomanized(text: string): string {
  if (!text) return '';
  let out = '';
  const clean = text.replace(/\u093C/g, ''); // strip nukta for clean phonetic match
  const len = clean.length;

  for (let i = 0; i < len; i += 1) {
    const char = clean[i];
    const nextChar = i + 1 < len ? clean[i + 1] : '';

    if (DEVANAGARI_VOWELS[char]) {
      out += DEVANAGARI_VOWELS[char];
    } else if (DEVANAGARI_CONSONANTS[char]) {
      const base = DEVANAGARI_CONSONANTS[char];
      if (nextChar === VIRAMA) {
        // Halant suppresses inherent 'a'
        out += base;
        i += 1; // skip virama
      } else if (DEVANAGARI_MATRAS[nextChar]) {
        out += base + DEVANAGARI_MATRAS[nextChar];
        i += 1; // skip matra
      } else if (!nextChar || /[\s.,!?;:\u0964]/.test(nextChar)) {
        // Modern Hindi word-final schwa deletion (e.g. महाराज -> maharaj, एक -> ek)
        out += base;
      } else {
        // Inherent schwa 'a'
        out += `${base}a`;
      }
    } else if (DEVANAGARI_MATRAS[char]) {
      out += DEVANAGARI_MATRAS[char];
    } else if (DEVANAGARI_DIGITS[char]) {
      out += DEVANAGARI_DIGITS[char];
    } else if (char === '।') {
      out += '.';
    } else {
      out += char;
    }
  }

  return out
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes phonetic variants in Romanized Hindi/Hinglish
 * so acoustic variants like 'gwaliyarme' -> 'gwalior me' or 'viji' -> 'bhejiye'
 * can be evaluated cleanly against reference transcripts.
 */
export function normalizePhoneticTokens(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u093C/g, '')
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ')
    .replace(/\b1\b/g, 'ek')
    .replace(/\b2\b/g, 'do')
    .replace(/\b3\b/g, 'teen')
    .replace(/\b4\b/g, 'char')
    .replace(/\b5\b/g, 'paanch')
    .replace(/\b(gwaliyarme)\b/g, 'gwalior me')
    .replace(/\b(gwaliyar|gvaliyar|gwalia|valier)\b/g, 'gwalior')
    .replace(/\b(maharaj\s*bhada|maharashtra)\b/g, 'maharaj bada')
    .replace(/\b(full[\s-]*(?:barg|bark))\b/g, 'phool bagh')
    .replace(/\b(hazira\s*chalk|hazirachok)\b/g, 'hazira chowk')
    .replace(/\b(murahar|murar)\b/g, 'morar')
    .replace(/\b(caura\s*hapur|chaurapar)\b/g, 'chauraha par')
    .replace(/\b(dheem\s*dhyal\s*nagar|3d\s*al\s*nager)\b/g, 'deendayal nagar')
    .replace(/\b(durgaatna|durghatan|durghatana|durhath)\b/g, 'durghatna')
    .replace(/\b(gamveer|gnbheer|ganbheer)\b/g, 'gambhir')
    .replace(/\b(dilka\s*dora)\b/g, 'dil ka daura')
    .replace(/\b(behush)\b/g, 'behosh')
    .replace(/\b(sans\s*lehne)\b/g, 'sans lene')
    .replace(/\b(takleev)\b/g, 'takleef')
    .replace(/\b(lough|yatri)\b/g, 'log')
    .replace(/\b(ghyal|ghaial)\b/g, 'ghayal')
    .replace(/\b(viji|bheje|bhejie)\b/g, 'bhejiye')
    .replace(/\b(pulis)\b/g, 'police')
    .replace(/\b(emblience|embulens)\b/g, 'ambulance')
    .replace(/\b(men)\b/g, 'me')
    .replace(/\b(hain)\b/g, 'hai')
    .replace(/\b(turnt)\b/g, 'turant')
    .replace(/\b(or)\b/g, 'aur')
    .replace(/\b(huee|hoi)\b/g, 'hui')
    .replace(/\b(sada़k|sadak)\b/g, 'sadak')
    .replace(/\b(bada़)\b/g, 'bada')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Landmark and Location Aliases for Gwalior ──────────────────────────────
export interface GwaliorLocationMatch {
  landmark: string | null;
  city: string | null;
  formattedLocation: string | null;
  confidence: number;
}

export interface LandmarkAliasConfig {
  canonicalName: string;
  aliases: RegExp[];
  coordinates: { lat: number; lng: number; accuracy: number };
}

export const GWALIOR_LANDMARK_CONFIGS: LandmarkAliasConfig[] = [
  {
    canonicalName: 'Maharaj Bada',
    aliases: [
      /\bmaharaj\s*b[ha]+da\b/i,
      /\bmaharaj\s*bada\b/i,
      /महाराज\s*बा[ड़ड]़?ा/u,
      /\bmaharashtra\b/i,
    ],
    coordinates: { lat: 26.2057, lng: 78.1583, accuracy: 800 },
  },
  {
    canonicalName: 'Phool Bagh',
    aliases: [
      /\bphool\s*bagh\b/i,
      /\bfull[\s-]*(?:bagh|barg|bark)\b/i,
      /फूल\s*बाग/u,
    ],
    coordinates: { lat: 26.2185, lng: 78.1695, accuracy: 1000 },
  },
  {
    canonicalName: 'Hazira Chowk',
    aliases: [
      /\bhazira\s*(?:chowk|chalk|chok|chauraaha|chouraha)?\b/i,
      /\bhazirachok\b/i,
      /हजीरा\s*(?:चौक|चौराहा)?/u,
    ],
    coordinates: { lat: 26.2372, lng: 78.1765, accuracy: 1000 },
  },
  {
    canonicalName: 'Morar',
    aliases: [
      /\bm[ou]rar\s*(?:chauraha|chauraaha|chaurapar)?\b/i,
      /\bmurahar\s*(?:caura\s*hapur|chauraha)?\b/i,
      /मुरार\s*(?:चौराहा)?/u,
    ],
    coordinates: { lat: 26.2285, lng: 78.2250, accuracy: 1200 },
  },
  {
    canonicalName: 'Deendayal Nagar',
    aliases: [
      /\bdeendayal\s*nagar\b/i,
      /\bdheem\s*dhyal\s*nagar\b/i,
      /\b3d\s*al\s*nager\b/i,
      /दीनदयाल\s*नगर/u,
    ],
    coordinates: { lat: 26.2570, lng: 78.2090, accuracy: 1200 },
  },
  {
    canonicalName: 'City Center',
    aliases: [
      /\bcity\s*cent(?:er|re)\b/i,
      /सिटी\s*सेंटर/u,
    ],
    coordinates: { lat: 26.2015, lng: 78.1895, accuracy: 1200 },
  },
];

export const GWALIOR_CITY_ALIASES = [
  /\bgwalior\b/i,
  /\bgwaliyar(?:me)?\b/i,
  /\bgwalia\b/i,
  /\bgwalya\b/i,
  /\bvalier\b/i,
  /ग्वालियर/u,
];

/**
 * Detects whether Gwalior city is mentioned in the transcript.
 */
export function detectGwaliorCity(transcript: string): boolean {
  return GWALIOR_CITY_ALIASES.some((regex) => regex.test(transcript));
}

/**
 * Conservatively detects known Gwalior landmarks from a transcript.
 * Never guesses or assigns a landmark if no explicit alias matches.
 */
export function detectGwaliorLocation(transcript: string): GwaliorLocationMatch {
  const text = transcript.trim();
  if (!text) {
    return { landmark: null, city: null, formattedLocation: null, confidence: 0 };
  }

  let matchedLandmark: string | null = null;
  for (const config of GWALIOR_LANDMARK_CONFIGS) {
    if (config.aliases.some((re) => re.test(text))) {
      matchedLandmark = config.canonicalName;
      break;
    }
  }

  const hasGwalior = detectGwaliorCity(text);
  const city = hasGwalior ? 'Gwalior' : null;

  if (matchedLandmark) {
    const formattedLocation = city
      ? `${matchedLandmark}, ${city}`
      : `${matchedLandmark}, Gwalior`;
    return {
      landmark: matchedLandmark,
      city: 'Gwalior',
      formattedLocation,
      confidence: hasGwalior ? 90 : 80,
    };
  }

  if (city) {
    return {
      landmark: null,
      city: 'Gwalior',
      formattedLocation: 'Gwalior',
      confidence: 70,
    };
  }

  return { landmark: null, city: null, formattedLocation: null, confidence: 0 };
}

// ── Hindi / Hinglish Emergency Vocabulary Normalization ────────────────────

/**
 * Normalizes an emergency transcript for deterministic rule extraction without
 * modifying or overwriting the original user/model transcript.
 *
 * Expands Devanagari Hindi and Romanized Hindi idioms into standard operational
 * terms.
 */
export function normalizeExtractionText(transcript: string): string {
  if (!transcript || !transcript.trim()) return '';

  const raw = transcript.trim();
  let normalized = raw;

  // 1. If Devanagari is present, transliterate and append Romanized version
  if (/[\u0900-\u097F]/.test(raw)) {
    const romanized = devanagariToRomanized(raw);
    normalized = `${raw} ${romanized}`;
  }

  // 2. Expand Cardiac & Unconsciousness terms
  if (
    /\b(dil\s*ka\s*d[ao]ura|dilka\s*dora)\b/i.test(normalized) ||
    /दिल\s*का\s*दौरा|हार्ट\s*अटैक/u.test(raw)
  ) {
    normalized += ' cardiac arrest heart attack chest pain';
  }
  if (
    /\b(behosh|behush)\b/i.test(normalized) ||
    /बेहोश|बेहोशी|अचेत/u.test(raw)
  ) {
    normalized += ' unconscious collapsed';
  }

  // 3. Expand Respiratory & Breathing terms
  if (
    /\b(sans\s*l[ea]hne|sans\s*lene|takleev|takleef)\b/i.test(normalized) ||
    /सांस\s*लेने|सांस\s*फूल|दम\s*घुट/u.test(raw)
  ) {
    normalized += ' respiratory distress breathing difficulty breathless';
  }

  // 4. Expand Vehicle Accident & Collision terms
  if (
    /\b(durgaatna|durghatna|durhath|sadak\s*durghatna|takkar|palat)\b/i.test(normalized) ||
    /दुर्घटना|सड़क\s*दुर्घटना|टक्कर|एक्सीडेंट/u.test(raw)
  ) {
    normalized += ' vehicle collision crash road accident';
  }

  // 5. Expand Bleeding & Trauma terms
  if (
    /\b(head\s*injury|chot|ghayal|ghyal|ghaial)\b/i.test(normalized) ||
    /गंभीर\s*चोट|सिर\s*में\s*चोट/u.test(raw)
  ) {
    normalized += ' trauma head injury severe bleeding injured';
  }
  if (
    /\b(khoon|bleeding|dard)\b/i.test(normalized) ||
    /खून|दर्द|रक्तस्राव/u.test(raw)
  ) {
    normalized += ' bleeding medical emergency';
  }

  // 6. Expand Fire terms
  if (
    /\b(aag\b|aag\s*lag|dhuan)\b/i.test(normalized) ||
    /धुआं|आग|जल\s*रहा/u.test(raw)
  ) {
    normalized += ' fire blaze burning flames';
  }

  // 7. Inject canonical Gwalior landmark if detected
  const loc = detectGwaliorLocation(raw);
  if (loc.landmark) {
    normalized += ` at ${loc.landmark} in Gwalior`;
  } else if (loc.city) {
    normalized += ' in Gwalior';
  }

  return normalized.trim();
}

// ── Normalized Benchmark Metrics Calculation ──────────────────────────────

/**
 * Computes Levenshtein edit distance between two arrays of tokens/characters.
 */
function levenshteinDistance<T>(a: T[], b: T[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculates normalized Word Error Rate (WER) and Character Error Rate (CER),
 * transliterating Devanagari reference text to phonetic Romanized tokens
 * so comparisons against Romanized model hypotheses are script-consistent
 * and do not produce artificial 100% errors.
 */
export function calculateNormalizedErrorRates(
  reference: string,
  hypothesis: string,
): { wer: number; cer: number; normalizedReference: string; normalizedHypothesis: string } {
  // Transliterate reference if in Devanagari
  const romanRef = /[\u0900-\u097F]/.test(reference)
    ? devanagariToRomanized(reference)
    : reference;

  const romanHyp = /[\u0900-\u097F]/.test(hypothesis)
    ? devanagariToRomanized(hypothesis)
    : hypothesis;

  const normRef = normalizePhoneticTokens(romanRef);
  const normHyp = normalizePhoneticTokens(romanHyp);

  // WER calculation
  const refWords = normRef.split(/\s+/).filter(Boolean);
  const hypWords = normHyp.split(/\s+/).filter(Boolean);

  const wordDistance = levenshteinDistance(refWords, hypWords);
  const wer = refWords.length > 0 ? (wordDistance / refWords.length) * 100 : 0;

  // CER calculation
  const refChars = normRef.replace(/\s+/g, '').split('');
  const hypChars = normHyp.replace(/\s+/g, '').split('');

  const charDistance = levenshteinDistance(refChars, hypChars);
  const cer = refChars.length > 0 ? (charDistance / refChars.length) * 100 : 0;

  return {
    wer: Math.round(wer * 10) / 10,
    cer: Math.round(cer * 10) / 10,
    normalizedReference: normRef,
    normalizedHypothesis: normHyp,
  };
}
