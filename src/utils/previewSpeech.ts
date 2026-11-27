import { DialogueTurn, SubtitleCue } from '../types';
import { splitTurnIntoPhraseSegments } from './subtitleUtils';

export interface SelectedPreviewVoices {
  emmaVoice: SpeechSynthesisVoice | null;
  chloeVoice: SpeechSynthesisVoice | null;
  emmaVoiceLabel: string;
  chloeVoiceLabel: string;
  usedDistinctVoices: boolean;
}

export interface SpeechPhraseSpan {
  cueIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  weight: number;
}

export interface SpeechTurnPlan {
  turnIndex: number;
  speaker: string;
  line: string;
  scheduledStartSec: number;
  scheduledEndSec: number;
  phraseSpans: SpeechPhraseSpan[];
}

const EXCLUDED_VOICE_PATTERNS = [
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'deranged',
  'espeak',
  'festival',
  'good news',
  'hysterical',
  'jester',
  'organ',
  'superstar',
  'trinoids',
  'whisper',
  'wobble',
  'zarvox',
  'junior',
  'fred',
  'ralph',
  'bruce',
];

const MALE_VOICE_HINTS = [
  'david',
  'mark',
  'guy',
  'daniel',
  'alex',
  'andrew',
  'brian',
  'christopher',
  'eric',
  'roger',
  'steffan',
  'ryan',
  'thomas',
  'george',
  'james',
  'aaron',
  'arthur',
  'evan',
  'lee',
  'liam',
  'male',
  'reed',
  'rocko',
  'sandy',
  'shelley',
  'eddy',
  'grandpa',
];

const PREFERRED_FEMALE_NATURAL_HINTS: Array<[string, number]> = [
  ['aria online (natural)', 120],
  ['jenny online (natural)', 118],
  ['ava online (natural)', 115],
  ['emma online (natural)', 114],
  ['michelle online (natural)', 110],
  ['samantha', 105],
  ['ava', 102],
  ['allison', 98],
  ['zoe', 96],
  ['victoria', 92],
  ['google us english', 90],
  ['microsoft aria', 88],
  ['microsoft jenny', 86],
  ['microsoft zira', 76],
  ['natural', 65],
  ['neural', 60],
  ['female', 45],
  ['karen', 35],
  ['serena', 35],
  ['susan', 34],
  ['helen', 32],
  ['linda', 30],
  ['joanna', 30],
  ['salli', 30],
  ['kendra', 30],
  ['ivy', 28],
];

export function isSpeechSynthesisSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  );
}

export async function loadBrowserVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!isSpeechSynthesisSupported()) return [];

  const synth = window.speechSynthesis;
  const initial = synth.getVoices();
  if (initial.length > 0) {
    return initial;
  }

  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener?.('voiceschanged', onVoicesChanged);
      window.clearTimeout(timer);
      resolve(synth.getVoices());
    };

    const onVoicesChanged = () => {
      if (synth.getVoices().length > 0) {
        finish();
      }
    };

    synth.addEventListener?.('voiceschanged', onVoicesChanged);
    const timer = window.setTimeout(finish, timeoutMs);
  });
}

function scoreVoiceForCollegeFemale(voice: SpeechSynthesisVoice): number {
  const nameLower = voice.name.toLowerCase();
  const langLower = voice.lang.toLowerCase();

  if (EXCLUDED_VOICE_PATTERNS.some((bad) => nameLower.includes(bad))) {
    return -1000;
  }

  let score = 0;
  if (langLower === 'en-us' || langLower === 'en_us') {
    score += 200;
  } else if (langLower.startsWith('en-us')) {
    score += 185;
  } else if (langLower.startsWith('en')) {
    score += 70;
  } else {
    score -= 400;
  }

  const isLikelyMale = MALE_VOICE_HINTS.some((hint) => {
    const regex = new RegExp(`\\b${hint}\\b`, 'i');
    return regex.test(nameLower);
  });
  if (isLikelyMale) {
    score -= 180;
  }

  for (const [hint, bonus] of PREFERRED_FEMALE_NATURAL_HINTS) {
    if (nameLower.includes(hint)) {
      score += bonus;
    }
  }

  if (voice.localService === false) {
    // Cloud/online natural voices when available are typically cleaner than legacy local voices
    score += 12;
  }
  if (voice.default && langLower.startsWith('en')) {
    score += 8;
  }

  return score;
}

export function selectDialoguePreviewVoices(
  voices: SpeechSynthesisVoice[]
): SelectedPreviewVoices {
  if (!voices || voices.length === 0) {
    return {
      emmaVoice: null,
      chloeVoice: null,
      emmaVoiceLabel: 'Browser Default (en-US)',
      chloeVoiceLabel: 'Browser Default (en-US)',
      usedDistinctVoices: false,
    };
  }

  const ranked = [...voices]
    .map((voice) => ({ voice, score: scoreVoiceForCollegeFemale(voice) }))
    .filter((entry) => entry.score > -500)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.voice.name.localeCompare(b.voice.name);
    });

  const englishRanked = ranked.filter((r) => r.voice.lang.toLowerCase().startsWith('en'));
  const pool = englishRanked.length > 0 ? englishRanked : ranked;

  const emmaVoice = pool[0]?.voice ?? voices[0] ?? null;
  const chloeCandidate = pool.find(
    (entry) =>
      entry.voice !== emmaVoice &&
      entry.voice.voiceURI !== emmaVoice?.voiceURI &&
      entry.voice.name !== emmaVoice?.name
  );
  const chloeVoice = chloeCandidate?.voice ?? emmaVoice;

  const usedDistinctVoices = Boolean(
    emmaVoice &&
      chloeVoice &&
      (emmaVoice.voiceURI !== chloeVoice.voiceURI || emmaVoice.name !== chloeVoice.name)
  );

  return {
    emmaVoice,
    chloeVoice,
    emmaVoiceLabel: emmaVoice ? `${emmaVoice.name} (${emmaVoice.lang})` : 'Browser Default (en-US)',
    chloeVoiceLabel: chloeVoice ? `${chloeVoice.name} (${chloeVoice.lang})` : 'Browser Default (en-US)',
    usedDistinctVoices,
  };
}

export function getSpeechParamsForSpeaker(
  speaker: string,
  voices: SelectedPreviewVoices
): {
  voice: SpeechSynthesisVoice | null;
  rate: number;
  pitch: number;
  lang: string;
} {
  const isChloe = speaker.trim().toLowerCase() === 'chloe';
  const voice = isChloe ? voices.chloeVoice : voices.emmaVoice;

  // Natural conversational pace (subtle differentiation if OS exposes only 1 voice, never exaggerated)
  if (voices.usedDistinctVoices) {
    return {
      voice,
      rate: isChloe ? 1.0 : 0.96,
      pitch: isChloe ? 1.02 : 0.99,
      lang: voice?.lang || 'en-US',
    };
  }

  return {
    voice,
    rate: isChloe ? 1.01 : 0.95,
    pitch: isChloe ? 1.04 : 0.98,
    lang: voice?.lang || 'en-US',
  };
}

/**
 * Maps each turn in a beat to its exact phrase spans and nominal timestamps
 * from the beat's existing SubtitleCue list so subtitles stay synced to speech.
 */
export function buildSpeechTurnPlans(
  dialogue: DialogueTurn[],
  subtitleCues: SubtitleCue[],
  beatDurationSec: number
): SpeechTurnPlan[] {
  const cleanTurns = dialogue.filter((d) => d.line.trim().length > 0);
  if (cleanTurns.length === 0) return [];

  let cueCursor = 0;
  return cleanTurns.map((turn, turnIndex) => {
    const line = turn.line.replace(/\s+/g, ' ').trim();
    const segments = splitTurnIntoPhraseSegments(line);
    const spanCount = Math.max(1, segments.length);
    const matchingCues = subtitleCues.slice(cueCursor, cueCursor + spanCount);
    cueCursor += spanCount;

    let searchFrom = 0;
    const phraseSpans: SpeechPhraseSpan[] = segments.map((segText, idx) => {
      const foundIdx = line.indexOf(segText, searchFrom);
      const charStart = foundIdx >= 0 ? foundIdx : searchFrom;
      const charEnd = charStart + segText.length;
      searchFrom = charEnd;

      const cueIdxInBeat = cueCursor - spanCount + idx;
      return {
        cueIndex: cueIdxInBeat,
        text: segText,
        charStart,
        charEnd,
        weight: Math.max(4, segText.length),
      };
    });

    const fallbackStart = Number(
      ((turnIndex / cleanTurns.length) * Math.max(1, beatDurationSec - 0.6) + 0.14).toFixed(2)
    );
    const fallbackEnd = Number(
      (((turnIndex + 1) / cleanTurns.length) * Math.max(1, beatDurationSec - 0.35)).toFixed(2)
    );

    const scheduledStartSec = matchingCues[0]?.startSec ?? fallbackStart;
    const scheduledEndSec =
      matchingCues[matchingCues.length - 1]?.endSec ?? fallbackEnd;

    return {
      turnIndex,
      speaker: turn.speaker,
      line,
      scheduledStartSec,
      scheduledEndSec,
      phraseSpans,
    };
  });
}
