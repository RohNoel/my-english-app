import { DialogueTurn, SubtitleCue } from '../types';

/**
 * Splits a single character dialogue turn into short, natural phrase segments
 * without omitting words, truncating with ellipses, or exceeding 2 lines per cue.
 */
export function splitTurnIntoPhraseSegments(rawLine: string): string[] {
  const clean = rawLine.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  // 1. Split cleanly at sentence boundaries (. ! ?) keeping punctuation attached
  const sentenceMatches = clean.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  const sentences = (sentenceMatches ?? [clean])
    .map((s) => s.trim())
    .filter(Boolean);

  const segments: string[] = [];

  for (const sentence of sentences) {
    // If a single sentence is already short/concise (fits comfortably in 1-2 short lines), keep it intact
    if (sentence.length <= 54) {
      segments.push(sentence);
      continue;
    }

    // Split longer compound sentences at natural clause punctuation (comma, semicolon, em-dash)
    const commaParts = sentence.split(/(?<=[,;—:])\s+/).map((p) => p.trim()).filter(Boolean);
    if (commaParts.length > 1) {
      let buffer = '';
      for (const part of commaParts) {
        const candidate = buffer ? `${buffer} ${part}` : part;
        if (buffer && candidate.length > 56) {
          segments.push(buffer);
          buffer = part;
        } else {
          buffer = candidate;
        }
      }
      if (buffer) {
        // Still guard very long single clauses (> 76 chars) at natural conjunction/preposition boundaries
        if (buffer.length > 76) {
          segments.push(...splitLongClauseNaturally(buffer));
        } else {
          segments.push(buffer);
        }
      }
      continue;
    }

    if (sentence.length > 76) {
      segments.push(...splitLongClauseNaturally(sentence));
    } else {
      segments.push(sentence);
    }
  }

  return segments;
}

function splitLongClauseNaturally(clause: string): string[] {
  const words = clause.split(/\s+/).filter(Boolean);
  if (words.length <= 8 || clause.length <= 76) {
    return [clause];
  }
  const mid = Math.ceil(words.length / 2);
  // Look near midpoint for a natural break word (and, but, or, so, for, to, because)
  const breakWords = new Set(['and', 'but', 'or', 'so', 'for', 'because', 'when', 'while']);
  let splitIdx = mid;
  for (let offset = 0; offset <= 3; offset++) {
    if (mid + offset < words.length - 2 && breakWords.has(words[mid + offset].toLowerCase())) {
      splitIdx = mid + offset;
      break;
    }
    if (mid - offset > 2 && breakWords.has(words[mid - offset].toLowerCase())) {
      splitIdx = mid - offset;
      break;
    }
  }
  return [
    words.slice(0, splitIdx).join(' '),
    words.slice(splitIdx).join(' '),
  ].filter(Boolean);
}

/**
 * Estimates natural spoken weight for a phrase segment (character duration + punctuation breathing room).
 */
export function computePhraseSpeechWeight(text: string): number {
  const trimmed = text.trim();
  const base = Math.max(6, trimmed.length);
  const commaCount = (trimmed.match(/[,;:]/g) || []).length;
  const endPunct = /[.!?]$/.test(trimmed) ? 1 : 0;
  return base + commaCount * 3.5 + endPunct * 4.5;
}

/**
 * Builds phrase-level SubtitleCues for a beat when server audio alignment is not yet available
 * (e.g., visual-only storyboard preview mode), keeping silent pauses clear between speakers & phrases.
 */
export function buildPhraseSubtitleCues(
  dialogue: DialogueTurn[],
  beatDurationSec: number
): SubtitleCue[] {
  const cleanTurns = dialogue.filter((d) => d.line.trim().length > 0);
  if (cleanTurns.length === 0) return [];

  const turnGapSec = 0.24;
  const phraseGapSec = 0.08;
  const leadInSec = 0.14;
  const tailOutSec = 0.35;

  const usableWindow = Math.max(
    1.8,
    beatDurationSec - leadInSec - tailOutSec - turnGapSec * (cleanTurns.length - 1)
  );

  const turnItems = cleanTurns.map((turn) => {
    const phrases = splitTurnIntoPhraseSegments(turn.line);
    const totalWeight = phrases.reduce((sum, p) => sum + computePhraseSpeechWeight(p), 0);
    return { speaker: turn.speaker, phrases, totalWeight };
  });

  const grandWeight = turnItems.reduce((sum, t) => sum + t.totalWeight, 0) || 1;
  const cues: SubtitleCue[] = [];
  let cursor = leadInSec;

  turnItems.forEach((item, tIdx) => {
    if (tIdx > 0) {
      cursor += turnGapSec;
    }
    const turnTotalSec = (item.totalWeight / grandWeight) * usableWindow;
    const internalGaps = phraseGapSec * Math.max(0, item.phrases.length - 1);
    const spokenSec = Math.max(0.6, turnTotalSec - internalGaps);

    item.phrases.forEach((phrase, pIdx) => {
      if (pIdx > 0) {
        cursor += phraseGapSec;
      }
      const w = computePhraseSpeechWeight(phrase);
      const phraseDur = (w / item.totalWeight) * spokenSec;
      cues.push({
        speaker: item.speaker,
        text: phrase,
        startSec: Number(cursor.toFixed(2)),
        endSec: Number((cursor + phraseDur).toFixed(2)),
      });
      cursor += phraseDur;
    });
  });

  return cues;
}

export function formatRetryDurationHuman(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `about ${seconds} seconds`;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  if (hrs > 0) {
    if (mins === 60) return `about ${hrs + 1} hours`;
    return mins > 0
      ? `about ${hrs} ${hrs === 1 ? 'hour' : 'hours'} and ${mins} ${mins === 1 ? 'minute' : 'minutes'}`
      : `about ${hrs} ${hrs === 1 ? 'hour' : 'hours'}`;
  }
  return `about ${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
}
