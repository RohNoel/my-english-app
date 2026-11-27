import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface CachedDialogueAudioRecord {
  beatId: string;
  dialogueAudioBase64: string;
  dialogueDurationSec: number;
  subtitleCues: Array<{
    speaker: string;
    text: string;
    startSec: number;
    endSec: number;
  }>;
  createdAt: string;
}

const DIALOGUE_CACHE_DIR = path.resolve('src/assets/audio/dialogue_cache');

export function computeDialogueCacheHash(
  beatId: string,
  turns: Array<{ speaker: string; line: string; voiceName: string }>
): string {
  const canonical = JSON.stringify({
    beatId,
    turns: turns.map((t) => ({
      speaker: t.speaker.trim().toLowerCase(),
      line: t.line.trim(),
      voiceName: t.voiceName,
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20);
}

export function getCachedDialogueAudio(
  beatId: string,
  turns: Array<{ speaker: string; line: string; voiceName: string }>
): CachedDialogueAudioRecord | null {
  try {
    const hash = computeDialogueCacheHash(beatId, turns);
    const filePath = path.join(DIALOGUE_CACHE_DIR, `${beatId}_${hash}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CachedDialogueAudioRecord;
    if (
      parsed &&
      typeof parsed.dialogueAudioBase64 === 'string' &&
      parsed.dialogueAudioBase64.length > 44 &&
      Array.isArray(parsed.subtitleCues)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCachedDialogueAudio(
  beatId: string,
  turns: Array<{ speaker: string; line: string; voiceName: string }>,
  record: Omit<CachedDialogueAudioRecord, 'beatId' | 'createdAt'>
): void {
  try {
    if (!record.dialogueAudioBase64) return;
    fs.mkdirSync(DIALOGUE_CACHE_DIR, { recursive: true });
    const hash = computeDialogueCacheHash(beatId, turns);
    const filePath = path.join(DIALOGUE_CACHE_DIR, `${beatId}_${hash}.json`);
    const fullRecord: CachedDialogueAudioRecord = {
      beatId,
      dialogueAudioBase64: record.dialogueAudioBase64,
      dialogueDurationSec: record.dialogueDurationSec,
      subtitleCues: record.subtitleCues,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(fullRecord));
  } catch {
    // Non-fatal if disk write is unavailable
  }
}
