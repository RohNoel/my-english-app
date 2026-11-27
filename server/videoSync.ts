import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { BeatId, SubtitleCue, VideoClipSegment, VisualStyleId } from '../src/types.ts';
import { getVideoFilePath } from './videoCache.ts';

export const CLIP_SYNC_VERSION = 2;

export interface ActiveAudioInterval {
  startSec: number;
  endSec: number;
}

export interface AnalyzedClipMetadata {
  analyzerVersion?: number;
  actualDurationSec: number;
  speechIntervals: ActiveAudioInterval[];
  fileSize: number;
  mtimeMs: number;
}

const ANALYZER_VERSION = 2;

function getSyncSidecarPath(style: VisualStyleId, filename: string): string | null {
  const videoPath = getVideoFilePath(style, filename);
  if (!videoPath) return null;
  const sidecarPath = `${videoPath}.sync.json`;
  const styleDir = path.dirname(videoPath);
  if (!sidecarPath.startsWith(styleDir + path.sep)) {
    return null;
  }
  return sidecarPath;
}

export function parseClipFilenameFromUrl(
  url: string,
  expectedStyle: VisualStyleId
): string | null {
  const match = url.match(/^\/api\/video\/clip\/([a-z0-9_]+)\/([a-z0-9_-]+\.mp4)$/i);
  if (!match) return null;
  if (match[1] !== expectedStyle) return null;
  return match[2];
}

function probeClipDurationSec(filePath: string, fallbackSec: number): number {
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const parsed = Number.parseFloat(out);
    if (Number.isFinite(parsed) && parsed > 0.2) {
      return Number(parsed.toFixed(3));
    }
  } catch {
    // Fall back to expected duration if ffprobe is unavailable
  }
  return fallbackSec;
}

function detectClipAudioIntervals(
  filePath: string,
  actualDurationSec: number
): ActiveAudioInterval[] {
  try {
    // ffmpeg writes silencedetect logs to stderr on exit 0; spawnSync captures stderr cleanly without shell execution
    const res = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        filePath,
        '-af',
        'silencedetect=noise=-32dB:d=0.18',
        '-f',
        'null',
        '-',
      ],
      { encoding: 'utf8', timeout: 8000 }
    );
    const stderr = typeof res.stderr === 'string' ? res.stderr : '';
    return parseSilenceDetectToIntervals(stderr, actualDurationSec);
  } catch {
    return [];
  }
}

export function parseSilenceDetectToIntervals(
  ffmpegOutput: string,
  actualDurationSec: number
): ActiveAudioInterval[] {
  if (!ffmpegOutput) return [];
  const events: Array<{ kind: 'start' | 'end'; time: number }> = [];
  const regex = /silence_(start|end):\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(ffmpegOutput)) !== null) {
    const time = Number.parseFloat(match[2]);
    if (Number.isFinite(time)) {
      events.push({ kind: match[1] as 'start' | 'end', time });
    }
  }
  if (events.length === 0) return [];

  const intervals: ActiveAudioInterval[] = [];
  let activeStart = 0;
  let inSilence = false;

  for (const ev of events) {
    if (ev.kind === 'start') {
      if (!inSilence && ev.time - activeStart >= 0.025) {
        intervals.push({
          startSec: Number(activeStart.toFixed(3)),
          endSec: Number(ev.time.toFixed(3)),
        });
      }
      inSilence = true;
    } else {
      activeStart = ev.time;
      inSilence = false;
    }
  }

  if (!inSilence && actualDurationSec - activeStart >= 0.08) {
    intervals.push({
      startSec: Number(activeStart.toFixed(3)),
      endSec: Number(actualDurationSec.toFixed(3)),
    });
  }

  return intervals;
}

export function getOrAnalyzeMp4Clip(
  style: VisualStyleId,
  filename: string,
  fallbackDurationSec: number
): AnalyzedClipMetadata {
  const filePath = getVideoFilePath(style, filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      actualDurationSec: fallbackDurationSec,
      speechIntervals: [],
      fileSize: 0,
      mtimeMs: 0,
    };
  }

  const stat = fs.statSync(filePath);
  const sidecarPath = getSyncSidecarPath(style, filename);

  if (sidecarPath && fs.existsSync(sidecarPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as AnalyzedClipMetadata;
      if (
        cached &&
        cached.analyzerVersion === ANALYZER_VERSION &&
        cached.fileSize === stat.size &&
        Math.abs(cached.mtimeMs - stat.mtimeMs) < 10 &&
        Number.isFinite(cached.actualDurationSec) &&
        Array.isArray(cached.speechIntervals)
      ) {
        return cached;
      }
    } catch {
      // Re-analyze if sidecar metadata is unreadable
    }
  }

  const actualDurationSec = probeClipDurationSec(filePath, fallbackDurationSec);
  const speechIntervals = detectClipAudioIntervals(filePath, actualDurationSec);
  const metadata: AnalyzedClipMetadata = {
    analyzerVersion: ANALYZER_VERSION,
    actualDurationSec,
    speechIntervals,
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
  };

  if (sidecarPath) {
    try {
      fs.writeFileSync(sidecarPath, JSON.stringify(metadata));
    } catch {
      // Non-fatal if sidecar cannot be written
    }
  }

  return metadata;
}

export function extractSpeechWindow(
  intervals: ActiveAudioInterval[],
  actualDurationSec: number
): {
  onsetSec: number | null;
  mainSpeechEndSec: number | null;
  speechAfterOnset: ActiveAudioInterval[];
} {
  const meaningful = intervals.filter((iv) => iv.endSec - iv.startSec >= 0.025);
  if (meaningful.length === 0) {
    return { onsetSec: null, mainSpeechEndSec: null, speechAfterOnset: [] };
  }

  // Skip an isolated brief pre-speech prop sound (e.g., straw sip < 0.26s followed by >= 0.50s pause)
  let startIdx = 0;
  if (meaningful.length >= 2) {
    const dur0 = meaningful[0].endSec - meaningful[0].startSec;
    const gap01 = meaningful[1].startSec - meaningful[0].endSec;
    if (dur0 < 0.26 && gap01 >= 0.5) {
      startIdx = 1;
    }
  }

  const speechAfterOnset = meaningful.slice(startIdx);
  const onsetSec = speechAfterOnset[0].startSec;

  // Exclude an isolated quiet chuckle/reaction tail after a >= 0.70s silence pause once dialogue ran >= 3s
  let mainSpeechEndSec = speechAfterOnset[speechAfterOnset.length - 1].endSec;
  let mainEndIdx = speechAfterOnset.length;
  for (let i = 1; i < speechAfterOnset.length; i++) {
    const prev = speechAfterOnset[i - 1];
    const curr = speechAfterOnset[i];
    const gap = curr.startSec - prev.endSec;
    if (gap >= 0.7 && prev.endSec - onsetSec >= 3.0 && curr.endSec - curr.startSec < 1.2) {
      mainSpeechEndSec = prev.endSec;
      mainEndIdx = i;
      break;
    }
  }

  return {
    onsetSec,
    mainSpeechEndSec: Math.min(actualDurationSec, mainSpeechEndSec),
    speechAfterOnset: speechAfterOnset.slice(0, mainEndIdx),
  };
}

function clampNumber(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round3(val: number): number {
  return Number(val.toFixed(3));
}

/**
 * Computes non-destructive playback trim offsets and gentle natural playback speeds
 * for any visual style so character lip movement, gestures, and reactions align cleanly
 * with the locked English dialogue audio and subtitle cues.
 */
export function synchronizeBeatClipsWithAudio(params: {
  style: VisualStyleId;
  beatId: BeatId;
  clips: VideoClipSegment[];
  subtitleCues?: SubtitleCue[];
  dialogueDurationSec?: number;
  beatTargetDurationSec: number;
}): VideoClipSegment[] {
  const { style, beatId, clips, subtitleCues = [], beatTargetDurationSec } = params;
  if (!Array.isArray(clips) || clips.length === 0) {
    return clips;
  }

  const firstCueStartSec = subtitleCues.length > 0 ? Math.max(0, subtitleCues[0].startSec) : 0;
  const lastCueEndSec =
    subtitleCues.length > 0
      ? subtitleCues[subtitleCues.length - 1].endSec
      : Math.max(4, (params.dialogueDurationSec ?? beatTargetDurationSec) - 0.3);

  // Beat 2 (Problem): Shot A = brief cat slideshow insert, Shot B = return two-shot reaction
  if (beatId === 'problem' && clips.length >= 2) {
    const insertClip = clips[0];
    const returnClip = clips[1];

    const insertFile = parseClipFilenameFromUrl(insertClip.url, style);
    const insertMeta = insertFile
      ? getOrAnalyzeMp4Clip(style, insertFile, insertClip.durationSec)
      : { actualDurationSec: insertClip.durationSec, speechIntervals: [] };

    const returnFile = parseClipFilenameFromUrl(returnClip.url, style);
    const returnMeta = returnFile
      ? getOrAnalyzeMp4Clip(style, returnFile, returnClip.durationSec)
      : { actualDurationSec: returnClip.durationSec, speechIntervals: [] };

    // Keep the cat-slideshow insert crisp (~1.25-1.35s) so we cut back to Emma in time for line 2 & "I'm mortified."
    const firstCueEnd = subtitleCues.length > 0 ? subtitleCues[0].endSec : 2.7;
    const insertDuration = round3(
      clampNumber(
        firstCueEnd * 0.48,
        1.15,
        Math.min(1.4, insertMeta.actualDurationSec - 0.1, beatTargetDurationSec * 0.22)
      )
    );

    const { onsetSec, mainSpeechEndSec } = extractSpeechWindow(
      returnMeta.speechIntervals,
      returnMeta.actualDurationSec
    );

    const visualAnticipationSec = 0.12;
    const detectedTrimStart =
      onsetSec !== null ? Math.max(0, onsetSec - visualAnticipationSec) : 0.45;
    const maxAllowedTrim = Math.max(0, returnMeta.actualDurationSec - 3.5);
    const returnTrimStart = round3(clampNumber(detectedTrimStart, 0, maxAllowedTrim));

    const remainingDialogueEnd = Math.max(1.5, lastCueEndSec - insertDuration);
    const remainingBeatDuration = Math.max(2.0, beatTargetDurationSec - insertDuration);
    const availablePlayableReturn = Math.max(
      1.5,
      returnMeta.actualDurationSec - 0.05 - returnTrimStart
    );

    const clipSpeechSpan =
      mainSpeechEndSec !== null && mainSpeechEndSec > returnTrimStart + 1.0
        ? mainSpeechEndSec - returnTrimStart
        : availablePlayableReturn * 0.85;

    const rateForDialogue = clipSpeechSpan / remainingDialogueEnd;
    // Keep rate gentle & natural while ensuring video spans smoothly across the laugh reaction
    const maxRateToAvoidFreeze = availablePlayableReturn / remainingBeatDuration;
    const blendedRate =
      rateForDialogue > maxRateToAvoidFreeze
        ? Math.max(0.94, Math.min(rateForDialogue, maxRateToAvoidFreeze + 0.02))
        : rateForDialogue;
    const returnPlaybackRate = round3(clampNumber(blendedRate, 0.92, 1.12));

    const returnTrimEnd = round3(
      Math.min(
        returnMeta.actualDurationSec,
        returnTrimStart + remainingBeatDuration * returnPlaybackRate + 0.1
      )
    );

    return [
      {
        ...insertClip,
        durationSec: insertMeta.actualDurationSec,
        actualDurationSec: insertMeta.actualDurationSec,
        trimStartSec: 0,
        trimEndSec: insertDuration,
        playbackRate: 1,
        syncVersion: CLIP_SYNC_VERSION,
      },
      {
        ...returnClip,
        durationSec: returnMeta.actualDurationSec,
        actualDurationSec: returnMeta.actualDurationSec,
        trimStartSec: returnTrimStart,
        trimEndSec: returnTrimEnd,
        playbackRate: returnPlaybackRate,
        syncVersion: CLIP_SYNC_VERSION,
      },
    ];
  }

  // Single-clip beats (Hook, Turn, Close)
  const mainClip = clips[0];
  const filename = parseClipFilenameFromUrl(mainClip.url, style);
  const meta = filename
    ? getOrAnalyzeMp4Clip(style, filename, mainClip.durationSec)
    : { actualDurationSec: mainClip.durationSec, speechIntervals: [] };

  const { onsetSec, mainSpeechEndSec } = extractSpeechWindow(
    meta.speechIntervals,
    meta.actualDurationSec
  );

  // Align speech onset slightly before vocal threshold (-0.14s) and preserve any natural cue lead-in
  const visualAnticipationSec = 0.14;
  const rawTrimStart =
    onsetSec !== null
      ? Math.max(0, onsetSec - visualAnticipationSec - firstCueStartSec * 0.95)
      : beatId === 'turn' || beatId === 'close'
      ? 0.9
      : 0.35;
  const maxAllowedTrim = Math.max(0, meta.actualDurationSec - 3.5);
  const trimStartSec = round3(clampNumber(rawTrimStart, 0, maxAllowedTrim));

  const ttsSpan = Math.max(1.5, lastCueEndSec - firstCueStartSec);
  const availablePlayable = Math.max(1.5, meta.actualDurationSec - 0.05 - trimStartSec);

  const clipSpeechSpan =
    mainSpeechEndSec !== null && mainSpeechEndSec > trimStartSec + 1.2
      ? mainSpeechEndSec - trimStartSec
      : availablePlayable * 0.85;

  let targetRate = clipSpeechSpan / ttsSpan;

  // On Close beat, ensure we still have live moving frames past the last dialogue word into fade-to-black
  const visibleBeatEndSec =
    beatId === 'close'
      ? Math.max(lastCueEndSec + 0.48, beatTargetDurationSec - 0.95)
      : beatTargetDurationSec;

  const maxRateBeforeEnd = availablePlayable / Math.max(1.5, visibleBeatEndSec);
  if (beatId === 'close' && targetRate < 0.92) {
    targetRate = Math.min(0.97, maxRateBeforeEnd);
  }
  if (targetRate > maxRateBeforeEnd && maxRateBeforeEnd >= 0.9) {
    targetRate = Math.min(targetRate, maxRateBeforeEnd + 0.02);
  }

  const playbackRate = round3(clampNumber(targetRate, 0.92, 1.14));
  const trimEndSec = round3(
    Math.min(meta.actualDurationSec, trimStartSec + beatTargetDurationSec * playbackRate + 0.15)
  );

  return [
    {
      ...mainClip,
      durationSec: meta.actualDurationSec,
      actualDurationSec: meta.actualDurationSec,
      trimStartSec,
      trimEndSec,
      playbackRate,
      syncVersion: CLIP_SYNC_VERSION,
    },
  ];
}
