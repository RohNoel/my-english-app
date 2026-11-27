import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  BeatId,
  PersistedMasterVideoInfo,
  SubtitleCue,
  VideoClipSegment,
  VisualStyleId,
} from '../src/types.ts';
import {
  ActiveAudioInterval,
  extractSpeechWindow,
  getOrAnalyzeMp4Clip,
  parseClipFilenameFromUrl,
} from './videoSync.ts';
import { getVideoFilePath, sanitizeStyleDir } from './videoCache.ts';
import { buildWavFromPcm, parseWavBuffer } from './laughTrack.ts';

const MASTER_CACHE_ROOT = path.resolve('server/cache/masters');
const PERSISTENT_MASTERS_ROOT = path.resolve('src/assets/videos/masters');
const DIST_MASTERS_ROOT = path.resolve('dist/src/assets/videos/masters');
const ALL_VALID_STYLES: VisualStyleId[] = [
  'live_action',
  '3d_animation',
  '2d_animation',
  'american_comic',
];

const MASTER_PLAN_VERSION = 7;
const MASTER_FPS = 24;
const MASTER_WIDTH = 1280;
const MASTER_HEIGHT = 720;
const END_CREDIT_TEXT = 'Made with Google AI Studio · Script by [Noel Roh]';
const FONT_BOLD_PATH = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf';

export interface MasterBeatInput {
  beatId: BeatId;
  beatDurationSec: number;
  clips: VideoClipSegment[];
  subtitleCues: SubtitleCue[];
  audioBase64: string;
  cutToBlackAtEnd?: boolean;
  hasLaughTrack?: boolean;
}

export interface PlannedVideoSlice {
  filePath: string;
  srcStartSec: number;
  srcEndSec: number;
  dstDurationSec: number;
  padSec: number;
  frameCount?: number;
}

export interface MasterVideoResult {
  cleanUrl: string;
  subtitledUrl: string;
  totalDurationSec: number;
  beatStarts: Record<string, { startSec: number; endSec: number; durationSec: number }>;
  editPlanSummary: Array<{
    beatId: BeatId;
    slices: Array<{
      clip: string;
      srcStartSec: number;
      srcEndSec: number;
      dstDurationSec: number;
      speed: number;
    }>;
  }>;
}

export interface PersistentMasterManifest extends PersistedMasterVideoInfo {
  version: number;
  cleanFilename: string;
  subtitledFilename: string;
  editPlanSummary: MasterVideoResult['editPlanSummary'];
}

const inFlightMasters = new Map<string, Promise<MasterVideoResult>>();

function getMasterDirsForStyle(safeStyle: string): string[] {
  return [
    path.resolve(PERSISTENT_MASTERS_ROOT, safeStyle),
    path.resolve(MASTER_CACHE_ROOT, safeStyle),
    path.resolve(DIST_MASTERS_ROOT, safeStyle),
  ];
}

function safeCopyIfMissing(srcPath: string, dstPath: string) {
  try {
    if (!fs.existsSync(srcPath) || fs.existsSync(dstPath)) return;
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
  } catch {
    // Read-only deployment directories ignore writes gracefully
  }
}

export function getMasterVideoFilePath(style: string, filename: string): string | null {
  try {
    const safeStyle = sanitizeStyleDir(style);
    if (!/^(clean|subtitled|imported)_[a-z0-9_]+_[a-f0-9]+\.mp4$/i.test(filename)) {
      return null;
    }
    for (const rootDir of [PERSISTENT_MASTERS_ROOT, MASTER_CACHE_ROOT, DIST_MASTERS_ROOT]) {
      const styleDir = path.resolve(rootDir, safeStyle);
      const resolved = path.resolve(styleDir, filename);
      if (resolved.startsWith(styleDir + path.sep) && fs.existsSync(resolved)) {
        return resolved;
      }
    }
    const defaultDir = path.resolve(MASTER_CACHE_ROOT, safeStyle);
    const fallbackResolved = path.resolve(defaultDir, filename);
    if (!fallbackResolved.startsWith(defaultDir + path.sep)) {
      return null;
    }
    return fallbackResolved;
  } catch {
    return null;
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round3(val: number): number {
  return Number(val.toFixed(3));
}

function mergeBriefGaps(
  intervals: ActiveAudioInterval[],
  maxGapSec: number
): ActiveAudioInterval[] {
  if (intervals.length <= 1) return intervals.map((x) => ({ ...x }));
  const merged: ActiveAudioInterval[] = [{ ...intervals[0] }];
  for (let i = 1; i < intervals.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = intervals[i];
    if (curr.startSec - prev.endSec <= maxGapSec) {
      prev.endSec = Math.max(prev.endSec, curr.endSec);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

function groupCuesBySpeaker(
  cues: SubtitleCue[]
): Array<{ speaker: string; startSec: number; endSec: number }> {
  if (cues.length === 0) return [];
  const groups: Array<{ speaker: string; startSec: number; endSec: number }> = [
    { speaker: cues[0].speaker, startSec: cues[0].startSec, endSec: cues[0].endSec },
  ];
  for (let i = 1; i < cues.length; i++) {
    const prev = groups[groups.length - 1];
    const curr = cues[i];
    if (curr.speaker.trim().toLowerCase() === prev.speaker.trim().toLowerCase()) {
      prev.endSec = Math.max(prev.endSec, curr.endSec);
    } else {
      groups.push({ speaker: curr.speaker, startSec: curr.startSec, endSec: curr.endSec });
    }
  }
  return groups;
}

function buildSlice(
  filePath: string,
  srcStartSec: number,
  srcEndSec: number,
  dstDurationSec: number,
  minSpeed = 0.64,
  maxSpeed = 1.16
): PlannedVideoSlice {
  const safeSrcStart = round3(Math.max(0, srcStartSec));
  const safeSrcEnd = round3(Math.max(safeSrcStart + 0.08, srcEndSec));
  const safeDst = round3(Math.max(0.08, dstDurationSec));
  const srcSpan = safeSrcEnd - safeSrcStart;
  const impliedSpeed = srcSpan / safeDst;

  let padSec = 0;
  if (impliedSpeed < minSpeed) {
    const maxSmoothDst = srcSpan / minSpeed;
    padSec = round3(Math.max(0, safeDst - maxSmoothDst));
  } else if (impliedSpeed > maxSpeed) {
    // Keep speed bounded gently inside maxSpeed by trimming tail if needed? No, never exceed maxSpeed
    // unless source cannot cover it; clamping playback speed handles smoothness cleanly.
  }

  return {
    filePath,
    srcStartSec: safeSrcStart,
    srcEndSec: safeSrcEnd,
    dstDurationSec: safeDst,
    padSec,
  };
}

/**
 * Plans frame-accurate, natural-speed visual slices aligning clip speech bursts, gestures,
 * and emotional reactions to the locked English dialogue & subtitle cues for ANY visual style.
 */
export function planBeatVisualSlices(params: {
  style: VisualStyleId;
  beatId: BeatId;
  beatDurationSec: number;
  clips: VideoClipSegment[];
  subtitleCues: SubtitleCue[];
}): PlannedVideoSlice[] {
  const { style, beatId, beatDurationSec, clips, subtitleCues } = params;
  if (!clips || clips.length === 0) {
    throw new Error(`No moving video clips available for beat ${beatId}.`);
  }

  const resolveFileAndMeta = (clip: VideoClipSegment) => {
    const filename = parseClipFilenameFromUrl(clip.url, style);
    if (!filename) {
      throw new Error(`Invalid clip URL for style ${style}: ${clip.url}`);
    }
    const filePath = getVideoFilePath(style, filename);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Cached video file missing on disk: ${filename}`);
    }
    const meta = getOrAnalyzeMp4Clip(style, filename, clip.durationSec);
    return { filePath, meta };
  };

  // Beat 2 (Problem): Shot A = brief cat slideshow insert, Shot B = return two-shot reaction
  if (beatId === 'problem' && clips.length >= 2) {
    const insertInfo = resolveFileAndMeta(clips[0]);
    const returnInfo = resolveFileAndMeta(clips[1]);

    const firstCueEnd = subtitleCues.length > 0 ? subtitleCues[0].endSec : 2.72;
    const insertDst = round3(
      clamp(
        firstCueEnd * 0.49,
        1.22,
        Math.min(1.38, insertInfo.meta.actualDurationSec - 0.1, beatDurationSec * 0.22)
      )
    );

    const { onsetSec, speechAfterOnset } = extractSpeechWindow(
      returnInfo.meta.speechIntervals,
      returnInfo.meta.actualDurationSec
    );
    // Keep 0.14s+ phrase pauses distinct in Beat 2 so each sentence matches its own burst
    const bursts = mergeBriefGaps(
      speechAfterOnset.filter((b) => b.endSec - b.startSec >= 0.25),
      0.12
    );

    const slices: PlannedVideoSlice[] = [
      buildSlice(insertInfo.filePath, 0, insertDst, insertDst, 0.9, 1.1),
    ];

    if (bursts.length >= 3 && subtitleCues.length >= 3) {
      // Align C0 remainder, C1, C2 (e.g. "I'm mortified."), and post-dialogue laugh reaction
      const c0 = subtitleCues[0];
      const c1 = subtitleCues[1];
      const c2 = subtitleCues[subtitleCues.length - 1];

      const b0 = bursts[0];
      const b1 = bursts[1];
      const b2 = bursts[2];

      // Choose entry inside b0 past laptop turn-around (~1.05s) so remaining b0 fits smoothly into (c0.end - insertDst)
      const remC0Dst = Math.max(0.5, c0.endSec - insertDst);
      const minEntry = Math.min(b0.endSec - 0.55, Math.max(0.45, b0.startSec));
      const maxEntry = Math.max(minEntry, b0.endSec - 0.5);
      const entryB0 = clamp(b0.endSec - remC0Dst * 0.94, minEntry, maxEntry);

      slices.push(buildSlice(returnInfo.filePath, entryB0, b0.endSec, remC0Dst, 0.82, 1.14));

      const gap01Dst = Math.max(0.06, c1.startSec - c0.endSec);
      if (b1.startSec > b0.endSec + 0.04) {
        slices.push(
          buildSlice(returnInfo.filePath, b0.endSec, b1.startSec, gap01Dst, 0.55, 1.25)
        );
      }

      const c1Dst = Math.max(0.5, c1.endSec - c1.startSec);
      slices.push(buildSlice(returnInfo.filePath, b1.startSec, b1.endSec, c1Dst, 0.84, 1.15));

      const gap12Dst = Math.max(0.08, c2.startSec - c1.endSec);
      if (b2.startSec > b1.endSec + 0.04) {
        slices.push(
          buildSlice(returnInfo.filePath, b1.endSec, b2.startSec, gap12Dst, 0.55, 1.25)
        );
      }

      const c2Dst = Math.max(0.4, c2.endSec - c2.startSec);
      slices.push(buildSlice(returnInfo.filePath, b2.startSec, b2.endSec, c2Dst, 0.84, 1.15));

      const usedSoFar = slices.reduce((s, x) => s + x.dstDurationSec, 0);
      const tailDst = Math.max(0.25, beatDurationSec - usedSoFar);
      const tailSrcEnd = Math.min(returnInfo.meta.actualDurationSec, b2.endSec + tailDst * 1.05);
      slices.push(
        buildSlice(returnInfo.filePath, b2.endSec, tailSrcEnd, tailDst, 0.65, 1.05)
      );
      return slices;
    }

    // Smooth single-return fallback for animated styles without distinct internal audio bursts
    const returnStart =
      onsetSec !== null
        ? clamp(onsetSec - 0.12, 0, Math.max(0, returnInfo.meta.actualDurationSec - 3.5))
        : 0.45;
    const remainingDst = Math.max(1.5, beatDurationSec - insertDst);
    const returnEnd = Math.min(
      returnInfo.meta.actualDurationSec,
      returnStart + remainingDst * 1.02
    );
    slices.push(
      buildSlice(returnInfo.filePath, returnStart, returnEnd, remainingDst, 0.72, 1.14)
    );
    return slices;
  }

  // Single-clip beats (Hook, Turn, Close)
  const mainInfo = resolveFileAndMeta(clips[0]);
  const actualDur = mainInfo.meta.actualDurationSec;
  const { onsetSec, mainSpeechEndSec, speechAfterOnset } = extractSpeechWindow(
    mainInfo.meta.speechIntervals,
    actualDur
  );

  const firstCueStart = subtitleCues.length > 0 ? Math.max(0, subtitleCues[0].startSec) : 0;
  const lastCueEnd =
    subtitleCues.length > 0
      ? subtitleCues[subtitleCues.length - 1].endSec
      : Math.max(4, beatDurationSec - 0.7);

  const visualAnticipationSec = 0.14;
  const trimStart =
    onsetSec !== null
      ? clamp(
          onsetSec - visualAnticipationSec - firstCueStart * 0.95,
          0,
          Math.max(0, actualDur - 3.5)
        )
      : beatId === 'turn' || beatId === 'close'
      ? 0.9
      : 0.35;

  const bursts = mergeBriefGaps(
    speechAfterOnset.filter((b) => b.endSec - b.startSec >= 0.18),
    0.34
  );
  const speakerGroups = groupCuesBySpeaker(subtitleCues);

  // Hook-style 2-speaker alignment: align speaker transition directly to the nearest clip silence gap
  if (speakerGroups.length === 2 && bursts.length >= 2 && mainSpeechEndSec !== null) {
    const g0 = speakerGroups[0];
    const g1 = speakerGroups[1];
    const totalDialogueSpan = Math.max(1.0, g1.endSec - g0.startSec);
    const expectedSplitRatio = (g0.endSec - g0.startSec) / totalDialogueSpan;
    const expectedClipSplit =
      trimStart + expectedSplitRatio * (mainSpeechEndSec - trimStart);

    let bestGap: { leftEnd: number; rightStart: number; dist: number } | null = null;
    for (let i = 1; i < bursts.length; i++) {
      const prev = bursts[i - 1];
      const curr = bursts[i];
      const mid = (prev.endSec + curr.startSec) / 2;
      const dist = Math.abs(mid - expectedClipSplit);
      if (dist <= 0.85 && (!bestGap || dist < bestGap.dist)) {
        bestGap = { leftEnd: prev.endSec, rightStart: curr.startSec, dist };
      }
    }

    if (bestGap) {
      const slices: PlannedVideoSlice[] = [
        buildSlice(
          mainInfo.filePath,
          trimStart,
          bestGap.leftEnd,
          Math.max(0.5, g0.endSec),
          0.84,
          1.15
        ),
        buildSlice(
          mainInfo.filePath,
          bestGap.leftEnd,
          bestGap.rightStart,
          Math.max(0.08, g1.startSec - g0.endSec),
          0.6,
          1.25
        ),
        buildSlice(
          mainInfo.filePath,
          bestGap.rightStart,
          mainSpeechEndSec,
          Math.max(0.5, g1.endSec - g1.startSec),
          0.84,
          1.16
        ),
      ];
      const used = slices.reduce((s, x) => s + x.dstDurationSec, 0);
      const tailDst = Math.max(0.2, beatDurationSec - used);
      const tailEnd = Math.min(actualDur, mainSpeechEndSec + tailDst);
      slices.push(
        buildSlice(mainInfo.filePath, mainSpeechEndSec, tailEnd, tailDst, 0.68, 1.08)
      );
      return slices;
    }
  }

  // Turn / Close cue-to-burst 1-to-1 alignment when burst count matches cue count (2 or 3 cues)
  if (
    subtitleCues.length >= 2 &&
    subtitleCues.length <= 3 &&
    bursts.length === subtitleCues.length
  ) {
    const slices: PlannedVideoSlice[] = [];
    let cursorClip = trimStart;
    let cursorBeat = 0;

    for (let i = 0; i < subtitleCues.length; i++) {
      const cue = subtitleCues[i];
      const burst = bursts[i];
      const burstStart = i === 0 ? Math.min(trimStart, burst.startSec) : burst.startSec;

      if (i > 0 && cue.startSec > cursorBeat + 0.04 && burstStart > cursorClip + 0.04) {
        slices.push(
          buildSlice(
            mainInfo.filePath,
            cursorClip,
            burstStart,
            cue.startSec - cursorBeat,
            0.62,
            1.25
          )
        );
        cursorBeat = cue.startSec;
      }

      const cueDst = Math.max(0.35, cue.endSec - cursorBeat);
      const srcStart = i === 0 ? trimStart : Math.max(cursorClip, burstStart);
      let srcEnd = burst.endSec;

      // On Close c0, stretch smoothly through the natural pause before c1 so characters never look stalled
      if (beatId === 'close' && i === 0 && bursts.length >= 2) {
        const nextBurst = bursts[1];
        srcEnd = Math.max(burst.endSec, Math.min(nextBurst.startSec - 0.16, burst.endSec + 0.55));
      }

      // On Close final cue, include up to ~0.45s of immediate reaction laughter before fade if available
      if (beatId === 'close' && i === subtitleCues.length - 1) {
        const extraLaughEnd = Math.min(actualDur - 0.45, Math.max(burst.endSec, srcStart + cueDst));
        const fadeLeadBeat = Math.max(cue.endSec + 0.36, beatDurationSec - 0.97);
        slices.push(
          buildSlice(
            mainInfo.filePath,
            srcStart,
            extraLaughEnd,
            fadeLeadBeat - cursorBeat,
            0.84,
            1.14
          )
        );
        cursorBeat = fadeLeadBeat;
        cursorClip = extraLaughEnd;
        continue;
      }

      slices.push(buildSlice(mainInfo.filePath, srcStart, srcEnd, cueDst, 0.82, 1.15));
      cursorBeat += cueDst;
      cursorClip = srcEnd;
    }

    const tailDst = Math.max(0.2, beatDurationSec - cursorBeat);
    const tailEnd = Math.min(actualDur, cursorClip + tailDst * 1.05);
    slices.push(
      buildSlice(mainInfo.filePath, cursorClip, tailEnd, tailDst, 0.64, 1.08)
    );
    return slices;
  }

  // Smooth general fallback for any beat or silent animated clip
  const available = Math.max(1.5, actualDur - trimStart);
  const clipEnd = Math.min(actualDur, trimStart + Math.max(lastCueEnd + 0.5, beatDurationSec));
  return [
    buildSlice(
      mainInfo.filePath,
      trimStart,
      Math.max(trimStart + 1.5, Math.min(actualDur, trimStart + available, clipEnd)),
      beatDurationSec,
      0.72,
      1.15
    ),
  ];
}

function wrapSubtitleBalancedTwoLines(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 44) return clean;
  const words = clean.split(' ').filter(Boolean);
  if (words.length <= 2) return clean;

  const targetHalf = clean.length / 2;
  let bestSplit = Math.ceil(words.length / 2);
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const diff = Math.abs(l1.length - l2.length) + Math.abs(l1.length - targetHalf) * 0.25;
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = i;
    }
  }
  return `${words.slice(0, bestSplit).join(' ')}\\N${words.slice(bestSplit).join(' ')}`;
}

function formatAssTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.min(99, Math.round((clamped - Math.floor(clamped)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function buildAssSubtitleFile(
  cues: Array<{ startSec: number; endSec: number; text: string }>
): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${MASTER_WIDTH}`,
    `PlayResY: ${MASTER_HEIGHT}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Noto Sans,32,&H00FFFFFF,&H00FFFFFF,&H48000000,&H00000000,-1,0,0,0,100,100,0,0,1,1.3,0,2,96,96,36,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = cues
    .filter((c) => c.text.trim().length > 0 && c.endSec > c.startSec)
    .map((c) => {
      const safeText = wrapSubtitleBalancedTwoLines(c.text)
        .replace(/\{/g, '(')
        .replace(/\}/g, ')');
      return `Dialogue: 0,${formatAssTime(c.startSec)},${formatAssTime(c.endSec)},Default,,0,0,0,,${safeText}`;
    });

  return [...header, ...events, ''].join('\n');
}

function padOrTrimBeatWavToExactDuration(wavBase64: string, targetSec: number): Buffer {
  const raw = wavBase64 ? Buffer.from(wavBase64, 'base64') : Buffer.alloc(0);
  const parsed = parseWavBuffer(raw);
  const sr = parsed.sampleRate || 24000;
  const ch = parsed.channels || 1;
  const bps = parsed.bitsPerSample || 16;
  const bytesPerSample = Math.max(1, bps / 8) * ch;
  const targetSamples = Math.max(1, Math.round(sr * targetSec));
  const targetBytes = targetSamples * bytesPerSample;

  let finalPcm: Buffer;
  if (parsed.pcmData.length >= targetBytes) {
    finalPcm = parsed.pcmData.subarray(0, targetBytes);
  } else {
    const padBuf = Buffer.alloc(targetBytes - parsed.pcmData.length);
    finalPcm = Buffer.concat([parsed.pcmData, padBuf]);
  }
  return buildWavFromPcm([finalPcm], sr, ch, bps);
}

function persistMasterArtifacts(params: {
  style: VisualStyleId;
  cleanFilename: string;
  subtitledFilename: string;
  cleanSrcPath: string;
  subtitledSrcPath: string;
  metaJson?: MasterVideoResult;
  manifest: PersistentMasterManifest;
}) {
  const safeStyle = sanitizeStyleDir(params.style);
  const dirs = [
    path.resolve(MASTER_CACHE_ROOT, safeStyle),
    path.resolve(PERSISTENT_MASTERS_ROOT, safeStyle),
  ];

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const dstClean = path.resolve(dir, params.cleanFilename);
      const dstSub = path.resolve(dir, params.subtitledFilename);
      if (dstClean.startsWith(dir + path.sep) && dstClean !== params.cleanSrcPath) {
        fs.copyFileSync(params.cleanSrcPath, dstClean);
      }
      if (dstSub.startsWith(dir + path.sep) && dstSub !== params.subtitledSrcPath) {
        fs.copyFileSync(params.subtitledSrcPath, dstSub);
      }
      if (params.metaJson) {
        const hashMatch = params.cleanFilename.match(/_([a-f0-9]+)\.mp4$/i);
        if (hashMatch) {
          fs.writeFileSync(
            path.resolve(dir, `meta_${safeStyle}_${hashMatch[1]}.json`),
            JSON.stringify(params.metaJson)
          );
        }
      }
      fs.writeFileSync(path.resolve(dir, 'manifest.json'), JSON.stringify(params.manifest, null, 2));
    } catch {
      // Ignore read-only production fs errors gracefully
    }
  }
}

export function getPersistentMasterForStyle(style: string): PersistentMasterManifest | null {
  try {
    const safeStyle = sanitizeStyleDir(style) as VisualStyleId;
    const dirs = getMasterDirsForStyle(safeStyle);

    // 1. Prefer manifest.json whose MP4 files are verified present on disk (>4KB)
    for (const dir of dirs) {
      const manifestPath = path.resolve(dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PersistentMasterManifest;
        const cleanFile = getMasterVideoFilePath(safeStyle, parsed.cleanFilename);
        const subFile = getMasterVideoFilePath(safeStyle, parsed.subtitledFilename);
        if (
          cleanFile &&
          subFile &&
          fs.existsSync(cleanFile) &&
          fs.existsSync(subFile) &&
          fs.statSync(cleanFile).size > 4096 &&
          fs.statSync(subFile).size > 4096
        ) {
          // Ensure persistent and cache directories stay synchronized
          const persistentDir = path.resolve(PERSISTENT_MASTERS_ROOT, safeStyle);
          const cacheDir = path.resolve(MASTER_CACHE_ROOT, safeStyle);
          safeCopyIfMissing(cleanFile, path.resolve(persistentDir, parsed.cleanFilename));
          safeCopyIfMissing(subFile, path.resolve(persistentDir, parsed.subtitledFilename));
          safeCopyIfMissing(cleanFile, path.resolve(cacheDir, parsed.cleanFilename));
          safeCopyIfMissing(subFile, path.resolve(cacheDir, parsed.subtitledFilename));
          safeCopyIfMissing(manifestPath, path.resolve(persistentDir, 'manifest.json'));
          safeCopyIfMissing(manifestPath, path.resolve(cacheDir, 'manifest.json'));
          return parsed;
        }
      } catch {
        // Try next directory or reconstruct from meta_*.json
      }
    }

    // 2. Fallback: reconstruct manifest from surviving meta_<style>_<hash>.json + MP4s
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => /^meta_[a-z0-9_]+_[a-f0-9]+\.json$/i.test(f));
      for (const metaFile of files) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.resolve(dir, metaFile), 'utf8')) as MasterVideoResult;
          const cleanFilename = path.basename(meta.cleanUrl || '');
          const subtitledFilename = path.basename(meta.subtitledUrl || '');
          const cleanFile = getMasterVideoFilePath(safeStyle, cleanFilename);
          const subFile = getMasterVideoFilePath(safeStyle, subtitledFilename);
          if (
            cleanFile &&
            subFile &&
            fs.existsSync(cleanFile) &&
            fs.existsSync(subFile) &&
            fs.statSync(cleanFile).size > 4096 &&
            fs.statSync(subFile).size > 4096
          ) {
            const manifest: PersistentMasterManifest = {
              version: MASTER_PLAN_VERSION,
              style: safeStyle,
              title: 'The Purr-fect Presentation',
              scenePlace: 'University café',
              sceneSituation:
                "Emma accidentally emailed her cat's birthday slideshow instead of their academic presentation slides.",
              cleanFilename,
              subtitledFilename,
              cleanUrl: `/api/video/master/${safeStyle}/${cleanFilename}`,
              subtitledUrl: `/api/video/master/${safeStyle}/${subtitledFilename}`,
              totalDurationSec: meta.totalDurationSec,
              beatStarts: meta.beatStarts,
              subtitleCuesByBeat: {},
              hasLaughTrackByBeat: { problem: safeStyle === 'live_action' },
              editPlanSummary: meta.editPlanSummary || [],
              updatedAt: new Date().toISOString(),
            };
            persistMasterArtifacts({
              style: safeStyle,
              cleanFilename,
              subtitledFilename,
              cleanSrcPath: cleanFile,
              subtitledSrcPath: subFile,
              metaJson: meta,
              manifest,
            });
            return manifest;
          }
        } catch {
          // Continue scanning
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function listPersistentMasters(): PersistedMasterVideoInfo[] {
  const results: PersistedMasterVideoInfo[] = [];
  for (const style of ALL_VALID_STYLES) {
    const manifest = getPersistentMasterForStyle(style);
    if (manifest) {
      results.push(manifest);
    }
  }
  return results;
}

/**
 * Extracts a beat's WAV audio track directly from the surviving persistent master MP4
 * when individual beat audio caches were lost on container restart (zero API calls).
 */
export function extractBeatAudioFromMaster(params: {
  style: VisualStyleId;
  beatId: BeatId;
  startSec: number;
  endSec: number;
}): { audioBase64: string; audioDurationSec: number } | null {
  try {
    const safeStyle = sanitizeStyleDir(params.style) as VisualStyleId;
    const manifest = getPersistentMasterForStyle(safeStyle);
    if (!manifest) return null;

    const cleanPath = getMasterVideoFilePath(safeStyle, manifest.cleanFilename);
    if (!cleanPath || !fs.existsSync(cleanPath)) return null;

    // Check disk cache for already-recovered beat WAV JSON first
    for (const dir of getMasterDirsForStyle(safeStyle)) {
      const recoveredPath = path.resolve(dir, `recovered_audio_${params.beatId}.json`);
      if (fs.existsSync(recoveredPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(recoveredPath, 'utf8')) as {
            audioBase64: string;
            audioDurationSec: number;
          };
          if (parsed && parsed.audioBase64 && parsed.audioBase64.length > 44) {
            return parsed;
          }
        } catch {
          // Re-extract cleanly below
        }
      }
    }

    const trimEndPadding = params.beatId === 'close' ? 1.15 : 0.25;
    const rawSpan = Math.max(1, params.endSec - params.startSec);
    const extractDur = Math.max(1, rawSpan - trimEndPadding);

    const tmpWav = path.join(
      os.tmpdir(),
      `cinelingo_recover_${safeStyle}_${params.beatId}_${Date.now()}.wav`
    );
    try {
      const proc = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-hide_banner',
          '-nostdin',
          '-ss',
          String(Math.max(0, params.startSec)),
          '-t',
          String(round3(extractDur)),
          '-i',
          cleanPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '24000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          tmpWav,
        ],
        { encoding: 'utf8', timeout: 15000 }
      );
      if (proc.status !== 0 || !fs.existsSync(tmpWav)) {
        return null;
      }
      const wavBuf = fs.readFileSync(tmpWav);
      const parsedWav = parseWavBuffer(wavBuf);
      const record = {
        audioBase64: wavBuf.toString('base64'),
        audioDurationSec: Number(parsedWav.durationSec.toFixed(2)),
      };
      for (const dir of [
        path.resolve(PERSISTENT_MASTERS_ROOT, safeStyle),
        path.resolve(MASTER_CACHE_ROOT, safeStyle),
      ]) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.resolve(dir, `recovered_audio_${params.beatId}.json`),
            JSON.stringify(record)
          );
        } catch {
          // Non-fatal if directory read-only
        }
      }
      return record;
    } finally {
      try {
        if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
      } catch {
        // Non-fatal temp cleanup
      }
    }
  } catch {
    return null;
  }
}

export function importMasterMp4Buffer(params: {
  style: VisualStyleId;
  mp4Buffer: Buffer;
  title?: string;
  scenePlace?: string;
  sceneSituation?: string;
  beatStarts?: Record<string, { startSec: number; endSec: number; durationSec: number }>;
  subtitleCuesByBeat?: Record<string, SubtitleCue[]>;
}): PersistentMasterManifest {
  const safeStyle = sanitizeStyleDir(params.style) as VisualStyleId;
  if (!params.mp4Buffer || params.mp4Buffer.length < 8192) {
    throw new Error('Uploaded file is too small to be a valid MP4 video.');
  }
  const ftypHeader = params.mp4Buffer.subarray(4, 8).toString('ascii');
  if (ftypHeader !== 'ftyp') {
    throw new Error('Uploaded file is not a valid MP4 container.');
  }

  const hash = crypto.createHash('sha256').update(params.mp4Buffer).digest('hex').slice(0, 16);
  const filename = `imported_${safeStyle}_${hash}.mp4`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinelingo_import_'));
  const tmpPath = path.join(tmpDir, filename);

  try {
    fs.writeFileSync(tmpPath, params.mp4Buffer);
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', tmpPath],
      { encoding: 'utf8', timeout: 10000 }
    );
    if (probe.status !== 0) {
      throw new Error('Could not read MP4 streams from the uploaded video.');
    }
    const info = JSON.parse(probe.stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    const hasVideo = (info.streams ?? []).some((s) => s.codec_type === 'video');
    const duration = Number(info.format?.duration ?? 0);
    if (!hasVideo || !Number.isFinite(duration) || duration < 2) {
      throw new Error('Uploaded MP4 does not contain a valid moving video stream.');
    }

    const totalDurationSec = Number(duration.toFixed(2));
    const defaultBeatStarts: Record<string, { startSec: number; endSec: number; durationSec: number }> =
      params.beatStarts && Object.keys(params.beatStarts).length >= 4
        ? params.beatStarts
        : {
            hook: { startSec: 0, endSec: 7, durationSec: 7 },
            problem: { startSec: 7, endSec: 15, durationSec: 8 },
            turn: { startSec: 15, endSec: 23, durationSec: 8 },
            close: {
              startSec: 23,
              endSec: totalDurationSec,
              durationSec: Number(Math.max(5, totalDurationSec - 23).toFixed(2)),
            },
          };

    const manifest: PersistentMasterManifest = {
      version: MASTER_PLAN_VERSION,
      style: safeStyle,
      title: params.title || 'The Purr-fect Presentation',
      scenePlace: params.scenePlace || 'University café',
      sceneSituation:
        params.sceneSituation ||
        "Emma accidentally emailed her cat's birthday slideshow instead of their academic presentation slides.",
      cleanFilename: filename,
      subtitledFilename: filename,
      cleanUrl: `/api/video/master/${safeStyle}/${filename}`,
      subtitledUrl: `/api/video/master/${safeStyle}/${filename}`,
      totalDurationSec,
      beatStarts: defaultBeatStarts,
      subtitleCuesByBeat: params.subtitleCuesByBeat || {},
      hasLaughTrackByBeat: { problem: safeStyle === 'live_action' },
      editPlanSummary: [],
      imported: true,
      updatedAt: new Date().toISOString(),
    };

    persistMasterArtifacts({
      style: safeStyle,
      cleanFilename: filename,
      subtitledFilename: filename,
      cleanSrcPath: tmpPath,
      subtitledSrcPath: tmpPath,
      manifest,
    });

    return manifest;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Non-fatal cleanup
    }
  }
}

/**
 * Assembles one continuous, frame-locked 1280x720@24fps H.264+AAC master MP4
 * (plus a burned-in subtitle version) directly from cached clips and audio.
 */
export async function assembleMasterVideo(params: {
  style: VisualStyleId;
  beats: MasterBeatInput[];
  title?: string;
  scenePlace?: string;
  sceneSituation?: string;
}): Promise<MasterVideoResult> {
  const safeStyle = sanitizeStyleDir(params.style) as VisualStyleId;
  const styleDir = path.resolve(MASTER_CACHE_ROOT, safeStyle);
  fs.mkdirSync(styleDir, { recursive: true });

  // Build deterministic cache key from source files, durations, audio fingerprints, and cues
  const hashInput = {
    v: MASTER_PLAN_VERSION,
    style: safeStyle,
    beats: params.beats.map((b) => ({
      beatId: b.beatId,
      beatDurationSec: b.beatDurationSec,
      clips: b.clips.map((c) => c.url),
      cues: b.subtitleCues,
      audioLen: b.audioBase64.length,
      audioSig: b.audioBase64.slice(96, 160),
    })),
  };
  const masterHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(hashInput))
    .digest('hex')
    .slice(0, 16);

  const cleanFilename = `clean_${safeStyle}_${masterHash}.mp4`;
  const subtitledFilename = `subtitled_${safeStyle}_${masterHash}.mp4`;
  const cleanPath = getMasterVideoFilePath(safeStyle, cleanFilename);
  const subtitledPath = getMasterVideoFilePath(safeStyle, subtitledFilename);
  const metaPathCache = path.resolve(styleDir, `meta_${safeStyle}_${masterHash}.json`);
  const metaPathPersist = path.resolve(
    PERSISTENT_MASTERS_ROOT,
    safeStyle,
    `meta_${safeStyle}_${masterHash}.json`
  );
  const metaPath = fs.existsSync(metaPathCache) ? metaPathCache : metaPathPersist;

  if (
    cleanPath &&
    subtitledPath &&
    fs.existsSync(cleanPath) &&
    fs.existsSync(subtitledPath) &&
    fs.existsSync(metaPath) &&
    fs.statSync(cleanPath).size > 4096 &&
    fs.statSync(subtitledPath).size > 4096
  ) {
    try {
      const cachedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MasterVideoResult;
      if (cachedMeta && cachedMeta.cleanUrl && cachedMeta.subtitledUrl) {
        // Ensure persistent vault copy & manifest stay synced on disk
        const existingManifest = getPersistentMasterForStyle(safeStyle);
        if (!existingManifest) {
          const subtitleCuesByBeat: Record<string, SubtitleCue[]> = {};
          const hasLaughTrackByBeat: Record<string, boolean> = {};
          for (const b of params.beats) {
            subtitleCuesByBeat[b.beatId] = b.subtitleCues;
            hasLaughTrackByBeat[b.beatId] = Boolean(
              b.hasLaughTrack || (safeStyle === 'live_action' && b.beatId === 'problem')
            );
          }
          persistMasterArtifacts({
            style: safeStyle,
            cleanFilename,
            subtitledFilename,
            cleanSrcPath: cleanPath,
            subtitledSrcPath: subtitledPath,
            metaJson: cachedMeta,
            manifest: {
              version: MASTER_PLAN_VERSION,
              style: safeStyle,
              title: params.title || 'The Purr-fect Presentation',
              scenePlace: params.scenePlace || 'University café',
              sceneSituation:
                params.sceneSituation ||
                "Emma accidentally emailed her cat's birthday slideshow instead of their academic presentation slides.",
              cleanFilename,
              subtitledFilename,
              cleanUrl: cachedMeta.cleanUrl,
              subtitledUrl: cachedMeta.subtitledUrl,
              totalDurationSec: cachedMeta.totalDurationSec,
              beatStarts: cachedMeta.beatStarts,
              subtitleCuesByBeat,
              hasLaughTrackByBeat,
              editPlanSummary: cachedMeta.editPlanSummary,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        return cachedMeta;
      }
    } catch {
      // Rebuild if metadata JSON is corrupted
    }
  }

  // If raw clips in server/cache/videos were cleared on restart but a persistent master MP4
  // already exists on disk for this style, return the persistent master without failing.
  const anyRawClipMissing = params.beats.some((b) =>
    (b.clips ?? []).some((c) => {
      const fn = parseClipFilenameFromUrl(c.url, safeStyle);
      if (!fn) return true;
      const fp = getVideoFilePath(safeStyle, fn);
      return !fp || !fs.existsSync(fp);
    })
  );
  if (anyRawClipMissing || params.beats.some((b) => !b.clips || b.clips.length === 0)) {
    const survivingMaster = getPersistentMasterForStyle(safeStyle);
    if (survivingMaster) {
      return {
        cleanUrl: survivingMaster.cleanUrl,
        subtitledUrl: survivingMaster.subtitledUrl,
        totalDurationSec: survivingMaster.totalDurationSec,
        beatStarts: survivingMaster.beatStarts,
        editPlanSummary: survivingMaster.editPlanSummary,
      };
    }
  }

  const inflightKey = `${safeStyle}:${masterHash}`;
  const existingPromise = inFlightMasters.get(inflightKey);
  if (existingPromise) {
    return existingPromise;
  }

  const buildPromise = (async (): Promise<MasterVideoResult> => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinelingo_master_'));
    try {
      const beatStarts: Record<string, { startSec: number; endSec: number; durationSec: number }> =
        {};
      const globalCues: Array<{ startSec: number; endSec: number; text: string }> = [];
      const subtitleCuesByBeat: Record<string, SubtitleCue[]> = {};
      const hasLaughTrackByBeat: Record<string, boolean> = {};
      const editPlanSummary: MasterVideoResult['editPlanSummary'] = [];
      const allSlices: PlannedVideoSlice[] = [];
      const beatWavPaths: string[] = [];

      let cursorSec = 0;
      let closeFadeStartGlobalSec: number | null = null;

      for (let bIdx = 0; bIdx < params.beats.length; bIdx++) {
        const b = params.beats[bIdx];
        const beatDur = round3(Math.max(4, b.beatDurationSec));
        const beatStart = round3(cursorSec);
        const beatEnd = round3(beatStart + beatDur);
        beatStarts[b.beatId] = { startSec: beatStart, endSec: beatEnd, durationSec: beatDur };
        subtitleCuesByBeat[b.beatId] = b.subtitleCues;
        hasLaughTrackByBeat[b.beatId] = Boolean(
          b.hasLaughTrack || (safeStyle === 'live_action' && b.beatId === 'problem')
        );

        for (const cue of b.subtitleCues) {
          globalCues.push({
            startSec: round3(beatStart + cue.startSec),
            endSec: round3(beatStart + cue.endSec),
            text: cue.text,
          });
        }

        if (b.beatId === 'close' || b.cutToBlackAtEnd) {
          const lastCueEndLocal =
            b.subtitleCues.length > 0
              ? b.subtitleCues[b.subtitleCues.length - 1].endSec
              : Math.max(4, beatDur - 1.15);
          const fadeLocal = Math.max(lastCueEndLocal + 0.36, beatDur - 0.97);
          closeFadeStartGlobalSec = round3(beatStart + fadeLocal);
        }

        const slices = planBeatVisualSlices({
          style: safeStyle,
          beatId: b.beatId,
          beatDurationSec: beatDur,
          clips: b.clips,
          subtitleCues: b.subtitleCues,
        });
        allSlices.push(...slices);
        editPlanSummary.push({
          beatId: b.beatId,
          slices: slices.map((s) => ({
            clip: path.basename(s.filePath),
            srcStartSec: s.srcStartSec,
            srcEndSec: s.srcEndSec,
            dstDurationSec: s.dstDurationSec,
            speed: round3((s.srcEndSec - s.srcStartSec) / Math.max(0.05, s.dstDurationSec - s.padSec)),
          })),
        });

        let wavBuf = padOrTrimBeatWavToExactDuration(b.audioBase64, beatDur);
        if (safeStyle === 'live_action' && b.beatId === 'close') {
          try {
            const parsedWav = parseWavBuffer(wavBuf);
            const sr = parsedWav.sampleRate;
            const ch = parsedWav.channels;
            const bps = parsedWav.bitsPerSample;
            const bytesPerSample = Math.max(1, bps / 8) * ch;
            const pcm = parsedWav.pcmData;
            const totalSamples = Math.floor(pcm.length / bytesPerSample);
            // Detect whether this Beat 4 WAV still contains the un-cut 1.64s laughter prefix
            // (speech extending past 4.8s). If already cut & shifted, speech finishes by ~4.3s.
            let tailEnergy = 0;
            const checkStart = Math.min(totalSamples, Math.round(4.6 * sr));
            const checkEnd = Math.min(totalSamples, Math.round(5.8 * sr));
            if (bps === 16 && checkEnd > checkStart) {
              let sumSq = 0;
              for (let smp = checkStart; smp < checkEnd; smp++) {
                const v = pcm.readInt16LE(smp * bytesPerSample) / 32768;
                sumSq += v * v;
              }
              tailEnergy = Math.sqrt(sumSq / (checkEnd - checkStart));
            }
            if (tailEnergy > 0.03) {
              const cutSamples = Math.min(totalSamples, Math.round(1.64 * sr));
              const shiftedPcm = Buffer.alloc(pcm.length);
              pcm.copy(shiftedPcm, 0, cutSamples * bytesPerSample, totalSamples * bytesPerSample);
              wavBuf = buildWavFromPcm([shiftedPcm], sr, ch, bps);
            }
          } catch (e) {
            console.error('[CineLingo Audio Cut-Shift Error]', e);
          }
        }
        const wavPath = path.join(tmpDir, `beat_${bIdx}.wav`);
        fs.writeFileSync(wavPath, wavBuf);
        beatWavPaths.push(wavPath);

        cursorSec = beatEnd;
      }

      const totalDurationSec = round3(cursorSec);
      const assPath = path.join(tmpDir, 'subtitles.ass');
      fs.writeFileSync(assPath, buildAssSubtitleFile(globalCues), 'utf8');

      const creditPath = path.join(tmpDir, 'credit.txt');
      fs.writeFileSync(creditPath, END_CREDIT_TEXT, 'utf8');

      // Deduplicate input MP4 files
      const inputVideoPaths: string[] = [];
      const inputIndexByPath = new Map<string, number>();
      for (const sl of allSlices) {
        if (!inputIndexByPath.has(sl.filePath)) {
          inputIndexByPath.set(sl.filePath, inputVideoPaths.length);
          inputVideoPaths.push(sl.filePath);
        }
      }

      const ffmpegArgs: string[] = ['-y', '-hide_banner', '-nostdin'];
      for (const vp of inputVideoPaths) {
        ffmpegArgs.push('-i', vp);
      }
      const audioBaseIdx = inputVideoPaths.length;
      for (const wp of beatWavPaths) {
        ffmpegArgs.push('-i', wp);
      }

      // Assign exact integer 24fps frame counts per slice so total video frames == total audio duration
      let cumSec = 0;
      let cumFrames = 0;
      allSlices.forEach((sl) => {
        cumSec += sl.dstDurationSec;
        const targetCumFrames = Math.round(cumSec * MASTER_FPS);
        const frames = Math.max(2, targetCumFrames - cumFrames);
        sl.frameCount = frames;
        cumFrames += frames;
      });

      const filterLines: string[] = [];
      const sliceTags: string[] = [];

      allSlices.forEach((sl, idx) => {
        const inIdx = inputIndexByPath.get(sl.filePath)!;
        const srcSpan = Math.max(0.05, sl.srcEndSec - sl.srcStartSec);
        const targetSec = (sl.frameCount ?? Math.round(sl.dstDurationSec * MASTER_FPS)) / MASTER_FPS;
        const playDst = Math.max(0.05, targetSec - sl.padSec);
        const ptsFactor = round3(playDst / srcSpan);
        const clonePadSec = round3(sl.padSec + 0.35);

        const tag = `[vseg${idx}]`;
        sliceTags.push(tag);
        filterLines.push(
          `[${inIdx}:v]trim=start=${sl.srcStartSec}:end=${sl.srcEndSec},setpts=(PTS-STARTPTS)*${ptsFactor},scale=${MASTER_WIDTH}:${MASTER_HEIGHT}:force_original_aspect_ratio=increase,crop=${MASTER_WIDTH}:${MASTER_HEIGHT},setsar=1,tpad=stop_mode=clone:stop_duration=${clonePadSec},fps=${MASTER_FPS},trim=end_frame=${sl.frameCount},setpts=PTS-STARTPTS${tag}`
        );
      });

      const fadeOutStart = closeFadeStartGlobalSec ?? Math.max(1, totalDurationSec - 0.97);
      const creditInStart = round3(fadeOutStart + 0.2);
      const creditFullAt = round3(creditInStart + 0.2);

      const escapedCreditPath = creditPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

      filterLines.push(
        `${sliceTags.join('')}concat=n=${allSlices.length}:v=1:a=0,fps=${MASTER_FPS},format=yuv420p,fade=t=in:st=0:d=0.12:color=#0A0A0C,fade=t=out:st=${fadeOutStart}:d=0.26:color=#0A0A0C,drawtext=fontfile=${FONT_BOLD_PATH}:textfile=${escapedCreditPath}:fontcolor=0xF5F0E6:fontsize=22:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,${creditInStart}),0,if(lt(t,${creditFullAt}),(t-${creditInStart})/0.20,1))',split=2[vclean][vsubsrc]`
      );
      filterLines.push(`[vsubsrc]subtitles=${escapedAssPath}[vsub]`);

      const audioTags: string[] = [];
      for (let i = 0; i < beatWavPaths.length; i++) {
        const tag = `[aseg${i}]`;
        audioTags.push(tag);
        filterLines.push(
          `[${audioBaseIdx + i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${tag}`
        );
      }
      filterLines.push(`${audioTags.join('')}concat=n=${beatWavPaths.length}:v=0:a=1[aout];[aout]asplit=2[aclean][asub]`);

      const filterScriptPath = path.join(tmpDir, 'filter.txt');
      fs.writeFileSync(filterScriptPath, filterLines.join(';\n'), 'utf8');

      const tmpCleanOut = path.join(tmpDir, cleanFilename);
      const tmpSubOut = path.join(tmpDir, subtitledFilename);

      ffmpegArgs.push(
        '-filter_complex_script',
        filterScriptPath,
        '-map',
        '[vclean]',
        '-map',
        '[aclean]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-g',
        '24',
        '-keyint_min',
        '12',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        tmpCleanOut,
        '-map',
        '[vsub]',
        '-map',
        '[asub]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-g',
        '24',
        '-keyint_min',
        '12',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        tmpSubOut
      );

      const proc = spawnSync('ffmpeg', ffmpegArgs, {
        encoding: 'utf8',
        timeout: 60000,
      });

      if (proc.status !== 0 || !fs.existsSync(tmpCleanOut) || !fs.existsSync(tmpSubOut)) {
        const errText = (proc.stderr || proc.stdout || 'FFmpeg assembly failed').slice(-800);
        throw new Error(`Master video assembly failed: ${errText}`);
      }

      const result: MasterVideoResult = {
        cleanUrl: `/api/video/master/${safeStyle}/${cleanFilename}`,
        subtitledUrl: `/api/video/master/${safeStyle}/${subtitledFilename}`,
        totalDurationSec,
        beatStarts,
        editPlanSummary,
      };

      const manifest: PersistentMasterManifest = {
        version: MASTER_PLAN_VERSION,
        style: safeStyle,
        title: params.title || 'The Purr-fect Presentation',
        scenePlace: params.scenePlace || 'University café',
        sceneSituation:
          params.sceneSituation ||
          "Emma accidentally emailed her cat's birthday slideshow instead of their academic presentation slides.",
        cleanFilename,
        subtitledFilename,
        cleanUrl: result.cleanUrl,
        subtitledUrl: result.subtitledUrl,
        totalDurationSec,
        beatStarts,
        subtitleCuesByBeat,
        hasLaughTrackByBeat,
        editPlanSummary,
        updatedAt: new Date().toISOString(),
      };

      persistMasterArtifacts({
        style: safeStyle,
        cleanFilename,
        subtitledFilename,
        cleanSrcPath: tmpCleanOut,
        subtitledSrcPath: tmpSubOut,
        metaJson: result,
        manifest,
      });

      return result;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Non-fatal temp cleanup
      }
      inFlightMasters.delete(inflightKey);
    }
  })();

  inFlightMasters.set(inflightKey, buildPromise);
  return buildPromise;
}
