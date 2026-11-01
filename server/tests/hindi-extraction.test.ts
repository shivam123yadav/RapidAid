import { describe, it, expect } from 'vitest';
import {
  devanagariToRomanized,
  normalizePhoneticTokens,
  detectGwaliorLocation,
  normalizeExtractionText,
  calculateNormalizedErrorRates,
} from '../src/services/hindiNormalizationService.js';
import { extractFromTranscript } from '../src/services/voiceExtractionService.js';
import {
  extractEmergencyInformation,
  extractSpokenLocation,
} from '../src/services/emergencyExtractionService.js';

describe('Phase 2: Hindi & Romanized Hindi Emergency Understanding', () => {
  describe('1. Hindi transcript normalization', () => {
    it('transliterates Devanagari Hindi to readable Romanized Latin text', () => {
      const devanagari = 'नमस्ते महाराज बाड़ा ग्वालियर में दुर्घटना हुई है';
      const romanized = devanagariToRomanized(devanagari);
      expect(romanized.toLowerCase()).toContain('namaste');
      expect(romanized.toLowerCase()).toContain('maharaj');
      expect(romanized.toLowerCase()).toMatch(/gvaliyar|gwalior/);
    });

    it('preserves English and Hinglish words unchanged', () => {
      const mixed = 'Emergency at Maharaj Bada. Ambulance jaldi bhejo please.';
      const res = normalizeExtractionText(mixed);
      expect(res).toContain('Emergency at Maharaj Bada');
      expect(res).toContain('Ambulance jaldi bhejo please');
    });

    it('produces normalizedExtractionText without mutating the original transcript', () => {
      const original = 'दीनदयाल नगर में दिल का दौरा पड़ा है';
      const normalized = normalizeExtractionText(original);
      // Original string is untouched
      expect(original).toBe('दीनदयाल नगर में दिल का दौरा पड़ा है');
      // Normalized contains domain-expanded English terms for NLP extraction
      expect(normalized).toContain('cardiac arrest');
      expect(normalized).toContain('heart attack');
      expect(normalized).toContain('Deendayal Nagar');
    });
  });

  describe('2. Location extraction & Gwalior landmark aliases', () => {
    it.each([
      ['Accident at Maharaj Bada in Gwalior', 'Maharaj Bada', 'Gwalior'],
      ['Severe collision at Maharaj Bhada', 'Maharaj Bada', 'Gwalior'],
      ['महाराज बाड़ा ग्वालियर में एक गंभीर सड़क दुर्घटना हुई है', 'Maharaj Bada', 'Gwalior'],
      ['Near Phool Bagh crossing', 'Phool Bagh', 'Gwalior'],
      ['Near full-barg crossing in Gwalia', 'Phool Bagh', 'Gwalior'],
      ['फूल बाग चौराहे पर मदद चाहिए', 'Phool Bagh', 'Gwalior'],
      ['Accident near Hazira Chowk in Gwalior', 'Hazira Chowk', 'Gwalior'],
      ['Accident near Hazira chalk in Valier', 'Hazira Chowk', 'Gwalior'],
      ['हजीरा चौक पर ऑटो पलट गया', 'Hazira Chowk', 'Gwalior'],
      ['मुरार चौराहा पर एक बस और कार की टक्कर हो गई', 'Morar', 'Gwalior'],
      ['murahar caura hapur 1 bus or car ki takkar ho gayi hai', 'Morar', 'Gwalior'],
      ['Near Murar', 'Morar', 'Gwalior'],
      ['दीनदयाल नगर ग्वालियर में एक व्यक्ति बेहोश है', 'Deendayal Nagar', 'Gwalior'],
      ['Dheem Dhyal Nagar Gwalior में 1 Wakti ko Dilka Dora Pada hai', 'Deendayal Nagar', 'Gwalior'],
      ['Emergency near City Center', 'City Center', 'Gwalior'],
    ])('conservatively recognizes %j as %s, %s', (transcript, expectedLandmark, expectedCity) => {
      const loc = detectGwaliorLocation(transcript);
      expect(loc.landmark).toBe(expectedLandmark);
      expect(loc.city).toBe(expectedCity);

      const spoken = extractSpokenLocation(transcript);
      expect(spoken.spokenLocation).toContain(expectedLandmark);
      expect(spoken.landmarks).toContain(expectedLandmark);
    });

    it('never automatically assigns a location when none was spoken', () => {
      const noLocation = 'Please send an ambulance quickly, someone is badly injured.';
      const loc = detectGwaliorLocation(noLocation);
      expect(loc.landmark).toBeNull();
      expect(loc.city).toBeNull();

      const spoken = extractSpokenLocation(noLocation);
      expect(spoken.spokenLocation).toBeNull();
      expect(spoken.landmarks).toEqual([]);
      expect(spoken.city).toBeNull();
    });
  });

  describe('3. Emergency classification for Hindi and Hinglish', () => {
    it('classifies cardiac arrest from Devanagari and Romanized Hindi', () => {
      const devanagari = extractFromTranscript('दीनदयाल नगर में व्यक्ति को दिल का दौरा पड़ा है');
      expect(devanagari.extractedData.incidentType).toBe('CARDIAC_ARREST');

      const romanized = extractFromTranscript('Wakti ko Dilka Dora Pada hai aur waha Behush hai');
      expect(romanized.extractedData.incidentType).toBe('CARDIAC_ARREST');
    });

    it('classifies breathing difficulty from Devanagari and Romanized Hindi', () => {
      const devanagari = extractFromTranscript('सांस लेने में बहुत तकलीफ हो रही है जल्दी आइए');
      expect(devanagari.extractedData.incidentType).toBe('RESPIRATORY_DISTRESS');

      const romanized = extractFromTranscript('Sans Lehne me Bhaag Takleev Ho Rahi hai');
      expect(romanized.extractedData.incidentType).toBe('RESPIRATORY_DISTRESS');
    });

    it('classifies vehicle accidents from Devanagari, Romanized Hindi, and English', () => {
      const devanagari = extractFromTranscript('मुरार चौराहा पर एक बस और कार की टक्कर हो गई है');
      expect(devanagari.extractedData.incidentType).toBe('VEHICLE_COLLISION');

      const romanized = extractFromTranscript('Gamveer Sadak Durgaatna Hoi hai Maharaj Bada me');
      expect(romanized.extractedData.incidentType).toBe('VEHICLE_COLLISION');

      const hinglish = extractFromTranscript('murahar caura hapur 1 bus or car ki takkar ho gayi hai');
      expect(hinglish.extractedData.incidentType).toBe('VEHICLE_COLLISION');
    });

    it('classifies trauma and bleeding injuries from Devanagari and Romanized Hindi', () => {
      const devanagari = extractFromTranscript('सिर में गंभीर चोट है और बहुत खून बह रहा है');
      expect(['TRAUMA', 'MEDICAL_EMERGENCY']).toContain(devanagari.extractedData.incidentType);

      const romanized = extractFromTranscript('A person is bleeding heavily after a head injury');
      expect(['TRAUMA', 'MEDICAL_EMERGENCY']).toContain(romanized.extractedData.incidentType);
    });

    it('classifies fire emergencies from Devanagari and Romanized Hindi', () => {
      const devanagari = extractFromTranscript('दुकान में भीषण आग लग गई है तुरंत दमकल भेजिए');
      expect(devanagari.extractedData.incidentType).toBe('FIRE');

      const romanized = extractFromTranscript('Ghar me aag lag gayi hai charo taraf dhuan hai');
      expect(romanized.extractedData.incidentType).toBe('FIRE');
    });

    it('keeps uncertain transcript classification as OTHER for human review', () => {
      const uncertain = extractFromTranscript('Namaste hum baat kar rahe the kal ki meeting ke baare me');
      expect(uncertain.extractedData.incidentType).toBe('OTHER');
    });
  });

  describe('4. Normalized benchmark metric calculation', () => {
    it('calculates comparable WER between Devanagari reference and Romanized hypothesis', () => {
      const reference = 'नमस्ते, महाराज बाड़ा ग्वालियर में एक गंभीर सड़क दुर्घटना हुई है। दो लोग घायल हैं और तुरंत एम्बुलेंस भेजिए।';
      const hypothesis = 'Namaste, Maharaj Bada Gwaliyarme, 1 Gamveer Sadak Durgaatna Hoi hai. 2 Lough Ghyal hai, or Turant Ambulance Viji.';

      const result = calculateNormalizedErrorRates(reference, hypothesis);
      // Normalized WER reflects true acoustic recognition rather than misleading 100% script mismatch
      expect(result.wer).toBeLessThan(60);
      expect(result.cer).toBeLessThan(25);
      expect(result.normalizedReference).toContain('maharaj bada');
      expect(result.normalizedHypothesis).toContain('maharaj bada');
    });

    it('calculates accurate error rates for Romanized Hindi Morar collision', () => {
      const reference = 'मुरार चौराहा पर एक बस और कार की टक्कर हो गई है। कई यात्री घायल हैं, तुरंत पुलिस और एम्बुलेंस की जरूरत है।';
      const hypothesis = 'murahar caura hapur 1 bus or car ki takkar ho gayi hai. Kairi Yatri Ghaial hai, Turanth Pulis aur ambulance ki zaururat hai.';

      const result = calculateNormalizedErrorRates(reference, hypothesis);
      expect(result.wer).toBeLessThan(85);
      expect(result.cer).toBeLessThan(35);
    });
  });

  describe('5. End-to-end emergency information extraction', () => {
    it('extracts all required facts and preserves both originalTranscript and normalizedExtractionText', () => {
      const input = 'नमस्ते, महाराज बाड़ा ग्वालियर में एक गंभीर सड़क दुर्घटना हुई है। दो लोग घायल हैं और तुरंत एम्बुलेंस भेजिए।';
      const info = extractEmergencyInformation(input);

      expect(info.emergencyType).toBe('VEHICLE_COLLISION');
      expect(info.spokenLocation).toBe('Maharaj Bada, Gwalior');
      expect(info.landmarks).toContain('Maharaj Bada');
      expect(info.city).toBe('Gwalior');
      expect(info.injuredPeople).toBe(2);
      expect(info.priority).toBe('HIGH');
      expect(info.originalTranscript).toBe(input);
      expect(info.normalizedExtractionText).toContain('vehicle collision');
    });
  });
});
