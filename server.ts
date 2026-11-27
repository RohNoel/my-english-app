import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import {
  ParsedWav,
  buildWavFromPcm,
  createAudioAiClient,
  getOrCreateStudioLaughTrack,
  mixStudioLaughAfterDialogue,
  parseWavBuffer,
} from './server/laughTrack.ts';
import {
  getCachedDialogueAudio,
  saveCachedDialogueAudio,
} from './server/audioCache.ts';
import { getVideoFilePath } from './server/videoCache.ts';
import {
  TurnTiming,
  advanceBeatVideoGeneration,
  createVideoAiClient,
  getBeatPendingOperationInfo,
  getCachedBeatVideoSegments,
} from './server/omniVideo.ts';
import { synchronizeBeatClipsWithAudio } from './server/videoSync.ts';
import {
  assembleMasterVideo,
  extractBeatAudioFromMaster,
  getMasterVideoFilePath,
  getPersistentMasterForStyle,
  importMasterMp4Buffer,
  listPersistentMasters,
  type MasterBeatInput,
} from './server/masterVideo.ts';
import {
  buildPhraseSubtitleCues,
  computePhraseSpeechWeight,
  splitTurnIntoPhraseSegments,
} from './src/utils/subtitleUtils.ts';
import {
  CHARACTER_PROP_CONSISTENCY_BY_STYLE,
  STORED_SHOT_BRIEFS,
  UPDATED_STYLE_BRIEFS,
} from './src/data/visualRegenerationSpec.ts';
import type { BeatId } from './src/types.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);

const VALID_STYLES = [
  'live_action',
  '3d_animation',
  '2d_animation',
  'american_comic',
] as const;
type ValidStyle = (typeof VALID_STYLES)[number];

const STYLE_DEFINITIONS: Record<ValidStyle, string> = UPDATED_STYLE_BRIEFS;

function isValidStyle(value: unknown): value is ValidStyle {
  return typeof value === 'string' && (VALID_STYLES as readonly string[]).includes(value);
}

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

interface ParsedApiError {
  status: number;
  message: string;
  errorType:
    | 'rate_limit'
    | 'daily_quota_exhausted'
    | 'paid_key_required'
    | 'auth'
    | 'server';
  retryAfterSec?: number;
  rawDetail: string;
}

function sanitizeErrorText(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]');
}

function getRawErrorString(err: unknown): string {
  if (err instanceof Error) {
    const extra = err as Error & { status?: number; cause?: unknown };
    return sanitizeErrorText(
      `${extra.message}${extra.cause ? ` | ${String(extra.cause)}` : ''}`
    );
  }
  try {
    return sanitizeErrorText(JSON.stringify(err));
  } catch {
    return sanitizeErrorText(String(err));
  }
}

function parseRetryAfterSeconds(rawMsg: string): number | undefined {
  const retryDelayMatch = rawMsg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryDelayMatch) {
    return Math.ceil(Number(retryDelayMatch[1]));
  }
  const retryInFullMatch = rawMsg.match(
    /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i
  );
  if (retryInFullMatch) {
    const h = Number(retryInFullMatch[1] || 0);
    const m = Number(retryInFullMatch[2] || 0);
    const s = Number(retryInFullMatch[3] || 0);
    return Math.ceil(h * 3600 + m * 60 + s);
  }
  return undefined;
}

function formatRetryTimeHuman(seconds?: number): string {
  if (!seconds || seconds <= 0) return 'later';
  if (seconds < 60) return `~${seconds} seconds`;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  if (hrs > 0) {
    return mins > 0 ? `~${hrs}h ${mins}m` : `~${hrs}h`;
  }
  return `~${mins} minutes`;
}

function isDailyQuotaError(rawMsg: string): boolean {
  const lower = rawMsg.toLowerCase();
  return (
    lower.includes('per_day') ||
    lower.includes('perday') ||
    lower.includes('requests_per_day') ||
    lower.includes('requestsperday') ||
    lower.includes('daily') ||
    lower.includes('generate_requests_per_model_per_day')
  );
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const raw = getRawErrorString(err);
      const is429 = raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429');
      const isDaily = is429 && isDailyQuotaError(raw);
      const apiDelaySec = parseRetryAfterSeconds(raw);

      // Never repeatedly retry exhausted daily quotas or long quota windows (>45s)
      if (isDaily || (is429 && apiDelaySec && apiDelaySec > 45)) {
        throw err;
      }

      const isTransient =
        raw.includes('503') ||
        raw.includes('500') ||
        raw.includes('UNAVAILABLE') ||
        raw.includes('ECONNRESET') ||
        raw.includes('ETIMEDOUT');

      if ((!is429 && !isTransient) || attempt === maxRetries) {
        throw err;
      }

      const waitMs =
        apiDelaySec && apiDelaySec > 0
          ? apiDelaySec * 1000
          : 1500 * Math.pow(2, attempt);

      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

function formatApiError(err: unknown, stage?: string): ParsedApiError {
  const rawDetail = getRawErrorString(err);
  const lower = rawDetail.toLowerCase();
  const isVideoStage = Boolean(stage && stage.includes('gemini-omni'));

  if (
    rawDetail.includes('PERMISSION_DENIED') ||
    rawDetail.includes('403') ||
    rawDetail.includes('API_KEY_INVALID')
  ) {
    console.error(`[Gemini Auth Error${stage ? ` @ ${stage}` : ''}]`, rawDetail);
    if (isVideoStage) {
      return {
        status: 403,
        errorType: 'paid_key_required',
        message:
          'Moving-character video generation requires a billing-enabled Gemini API key in Settings > Secrets.',
        rawDetail,
      };
    }
    return {
      status: 403,
      errorType: 'auth',
      message: 'Voice generation service configuration needs attention.',
      rawDetail,
    };
  }
  if (rawDetail.includes('RESOURCE_EXHAUSTED') || rawDetail.includes('429')) {
    const daily = isDailyQuotaError(rawDetail);
    const retryAfterSec = parseRetryAfterSeconds(rawDetail);
    const isZeroFreeTierLimit =
      isVideoStage &&
      (lower.includes('limit: 0') ||
        lower.includes('"limit":0') ||
        lower.includes('free_tier') ||
        lower.includes('billing') ||
        lower.includes('paid'));
    console.error(`[Gemini 429${stage ? ` @ ${stage}` : ''}]`, rawDetail);

    if (isZeroFreeTierLimit) {
      return {
        status: 429,
        errorType: 'paid_key_required',
        retryAfterSec,
        message:
          'Moving-character video generation requires a paid Gemini API key in Settings > Secrets.',
        rawDetail,
      };
    }

    return {
      status: 429,
      errorType: daily ? 'daily_quota_exhausted' : 'rate_limit',
      retryAfterSec,
      message: isVideoStage
        ? daily
          ? 'Video generation quota is exhausted for today. Connect a paid key in Settings > Secrets or use the Animated Slideshow Fallback.'
          : 'Video generation rate limit reached. Wait briefly and retry, or switch to the Animated Slideshow Fallback.'
        : daily
        ? "You've reached today's free generation limit. Your project has been saved."
        : 'Temporary generation limit reached. Please wait briefly before continuing.',
      rawDetail,
    };
  }
  if (
    isVideoStage &&
    (lower.includes('paid') || lower.includes('billing'))
  ) {
    console.error(`[Gemini Video Access Error @ ${stage}]`, rawDetail);
    return {
      status: 403,
      errorType: 'paid_key_required',
      message:
        'Moving-character video generation requires a billing-enabled Gemini API key in Settings > Secrets.',
      rawDetail,
    };
  }
  if (
    isVideoStage &&
    (lower.includes('not_found') || lower.includes('404'))
  ) {
    console.error(`[Gemini Video 404 Error @ ${stage}]`, rawDetail);
    return {
      status: 404,
      errorType: 'server',
      message: `Video generation endpoint or operation was not found (${rawDetail.slice(0, 140)}).`,
      rawDetail,
    };
  }
  console.error(`[Gemini Error${stage ? ` @ ${stage}` : ''}]`, rawDetail);
  if (isVideoStage) {
    const shortReason =
      rawDetail.includes('ETIMEDOUT') || lower.includes('timeout') || lower.includes('aborted')
        ? 'Video generation request timed out before completion.'
        : lower.includes('safety') || lower.includes('blocked') || lower.includes('policy')
        ? `Video request was blocked by content policy (${rawDetail.slice(0, 140)}).`
        : lower.includes('400') || lower.includes('invalid')
        ? `Video generation rejected parameters (${rawDetail.slice(0, 140)}).`
        : lower.includes('503') || lower.includes('unavailable')
        ? 'Video generation service is temporarily overloaded (503 Unavailable).'
        : `Video generation failed: ${rawDetail.slice(0, 160)}`;
    return {
      status: 500,
      errorType: 'server',
      message: `${shortReason} You can retry this clip or choose how to proceed.`,
      rawDetail,
    };
  }
  return {
    status: 500,
    errorType: 'server',
    message: 'Unable to complete scene generation right now. Please try again.',
    rawDetail,
  };
}

function deriveSpeakerTurnTimings(
  cleanTurns: Array<{ speaker: string; line: string }>,
  subtitleCues: Array<{ speaker: string; text: string; startSec: number; endSec: number }>
): TurnTiming[] {
  if (cleanTurns.length === 0 || subtitleCues.length === 0) return [];
  const timings: TurnTiming[] = [];
  let cueIdx = 0;

  for (const turn of cleanTurns) {
    const expectedPhraseCount = Math.max(1, splitTurnIntoPhraseSegments(turn.line).length);
    const slice = subtitleCues.slice(cueIdx, cueIdx + expectedPhraseCount);
    if (slice.length > 0) {
      timings.push({
        speaker: turn.speaker,
        line: turn.line,
        startSec: slice[0].startSec,
        endSec: slice[slice.length - 1].endSec,
      });
      cueIdx += slice.length;
    } else {
      // Fallback: match remaining cues by speaker name if phrase counts differ
      const bySpeaker = subtitleCues
        .slice(cueIdx)
        .filter((c) => c.speaker.trim().toLowerCase() === turn.speaker.trim().toLowerCase());
      if (bySpeaker.length > 0) {
        timings.push({
          speaker: turn.speaker,
          line: turn.line,
          startSec: bySpeaker[0].startSec,
          endSec: bySpeaker[bySpeaker.length - 1].endSec,
        });
      }
    }
  }
  return timings;
}

/**
 * Measures active speech start/end and internal silent gaps in 16-bit PCM audio
 * so phrase subtitle cues align cleanly to real spoken timing and clear during pauses.
 */
function alignPhrasesToTurnPcm(params: {
  pcmData: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  turnOffsetSec: number;
  turnDurationSec: number;
  speaker: string;
  line: string;
}): Array<{ speaker: string; text: string; startSec: number; endSec: number }> {
  const {
    pcmData,
    sampleRate,
    channels,
    bitsPerSample,
    turnOffsetSec,
    turnDurationSec,
    speaker,
    line,
  } = params;
  const phrases = splitTurnIntoPhraseSegments(line);
  if (phrases.length === 0) return [];

  const bytesPerSample = Math.max(1, bitsPerSample / 8) * Math.max(1, channels);
  const totalSamples = Math.floor(pcmData.length / bytesPerSample);
  const winSec = 0.02;
  const winSamples = Math.max(1, Math.round(sampleRate * winSec));
  const threshold = 0.012;

  const rmsWindows: number[] = [];
  if (bitsPerSample === 16 && totalSamples > 0) {
    for (let s = 0; s < totalSamples; s += winSamples) {
      const end = Math.min(totalSamples, s + winSamples);
      let sumSq = 0;
      for (let i = s; i < end; i++) {
        const val = pcmData.readInt16LE(i * bytesPerSample) / 32768;
        sumSq += val * val;
      }
      rmsWindows.push(Math.sqrt(sumSq / Math.max(1, end - s)));
    }
  }

  let firstActiveIdx = 0;
  let lastActiveIdx = Math.max(0, rmsWindows.length - 1);
  if (rmsWindows.length > 4) {
    while (firstActiveIdx < rmsWindows.length - 1 && rmsWindows[firstActiveIdx] < threshold) {
      firstActiveIdx++;
    }
    while (lastActiveIdx > firstActiveIdx && rmsWindows[lastActiveIdx] < threshold) {
      lastActiveIdx--;
    }
  }

  const speechStartLocal =
    rmsWindows.length > 0 ? Math.max(0, firstActiveIdx * winSec - 0.02) : 0;
  const speechEndLocal =
    rmsWindows.length > 0
      ? Math.min(turnDurationSec, (lastActiveIdx + 1) * winSec + 0.04)
      : turnDurationSec;
  const activeSpan = Math.max(0.5, speechEndLocal - speechStartLocal);

  // Detect internal silent gaps >= 100ms (5 consecutive windows below threshold)
  const internalGaps: Array<{ startLocal: number; endLocal: number; midLocal: number }> = [];
  let gapStart = -1;
  for (let w = firstActiveIdx + 2; w < lastActiveIdx - 2; w++) {
    if (rmsWindows[w] < threshold) {
      if (gapStart === -1) gapStart = w;
    } else if (gapStart !== -1) {
      if (w - gapStart >= 5) {
        const sSec = gapStart * winSec;
        const eSec = w * winSec;
        internalGaps.push({
          startLocal: sSec,
          endLocal: eSec,
          midLocal: (sSec + eSec) / 2,
        });
      }
      gapStart = -1;
    }
  }

  const weights = phrases.map(computePhraseSpeechWeight);
  const totalWeight = weights.reduce((s, w) => s + w, 0) || 1;

  // Compute expected boundary times and snap to nearby real silent pauses if available
  const boundaries: Array<{ start: number; end: number }> = [];
  let cursor = speechStartLocal;
  const usedGapIdx = new Set<number>();

  for (let i = 0; i < phrases.length; i++) {
    const start = i === 0 ? speechStartLocal : cursor;
    let end =
      i === phrases.length - 1
        ? speechEndLocal
        : start + (weights[i] / totalWeight) * activeSpan;

    let nextStart = end;
    if (i < phrases.length - 1 && internalGaps.length > 0) {
      let bestIdx = -1;
      let bestDist = 0.55;
      internalGaps.forEach((g, gi) => {
        if (usedGapIdx.has(gi)) return;
        const dist = Math.abs(g.midLocal - end);
        if (dist < bestDist && g.startLocal > start + 0.35 && g.endLocal < speechEndLocal - 0.3) {
          bestDist = dist;
          bestIdx = gi;
        }
      });
      if (bestIdx !== -1) {
        usedGapIdx.add(bestIdx);
        end = internalGaps[bestIdx].startLocal + 0.02;
        nextStart = internalGaps[bestIdx].endLocal - 0.02;
      } else {
        // Leave brief visual clarity gap on comma/sentence boundaries
        end = Math.max(start + 0.25, end - 0.04);
        nextStart = end + 0.04;
      }
    }

    boundaries.push({ start, end });
    cursor = nextStart;
  }

  return phrases.map((text, idx) => ({
    speaker,
    text,
    startSec: Number((turnOffsetSec + boundaries[idx].start).toFixed(2)),
    endSec: Number((turnOffsetSec + boundaries[idx].end).toFixed(2)),
  }));
}

function getVoiceForSpeaker(
  speakerName: string,
  characters: Array<{ name: string; voiceName: string }>
): string {
  const normalized = speakerName.trim().toLowerCase();
  // Explicit consistent voices for Chloe and Emma across all 4 beats
  if (normalized === 'chloe') return 'Zephyr';
  if (normalized === 'emma') return 'Kore';

  const matched = characters.find(
    (c) => c.name.trim().toLowerCase() === normalized
  );
  const validVoices = ['Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir'];
  if (matched && validVoices.includes(matched.voiceName)) {
    return matched.voiceName;
  }
  return 'Kore';
}

const SCENE_DIRECTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    environment: { type: Type.STRING },
    cameraFraming: { type: Type.STRING },
    kenBurns: {
      type: Type.OBJECT,
      properties: {
        startScale: { type: Type.NUMBER },
        endScale: { type: Type.NUMBER },
        startX: { type: Type.NUMBER },
        endX: { type: Type.NUMBER },
        startY: { type: Type.NUMBER },
        endY: { type: Type.NUMBER },
      },
      required: ['startScale', 'endScale', 'startX', 'endX', 'startY', 'endY'],
    },
    leftCharacterMood: { type: Type.STRING },
    rightCharacterMood: { type: Type.STRING },
    activeProp: { type: Type.STRING },
    cutToBlackAtEnd: { type: Type.BOOLEAN },
    visualAccentNote: { type: Type.STRING },
  },
  required: [
    'environment',
    'cameraFraming',
    'kenBurns',
    'leftCharacterMood',
    'rightCharacterMood',
    'activeProp',
    'cutToBlackAtEnd',
    'visualAccentNote',
  ],
};

const app = express();
app.use(express.json({ limit: '10mb' }));

async function generateStyleAwareDirection(
  ai: GoogleGenAI,
  beat: {
    id: string;
    label: string;
    sceneDescription: string;
    dialogue: Array<{ speaker: string; line: string }>;
    visualDirection?: Record<string, unknown>;
  },
  characters: Array<{ name: string }>,
  scene: { place: string },
  style: ValidStyle,
  stylePromptOverride?: string,
  isRegeneration = false
) {
  const styleDefinition =
    typeof stylePromptOverride === 'string' && stylePromptOverride.trim().length > 40
      ? `${STYLE_DEFINITIONS[style]}\n${stylePromptOverride.trim()}`
      : STYLE_DEFINITIONS[style];

  const bible = CHARACTER_PROP_CONSISTENCY_BY_STYLE[style];
  const beatKey: BeatId =
    beat.id === 'hook' || beat.id === 'problem' || beat.id === 'turn' || beat.id === 'close'
      ? beat.id
      : 'hook';
  const storedShot = STORED_SHOT_BRIEFS[style][beatKey];
  const beatCompositionRule = storedShot.prompt;

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Direct the visual composition and camera motion for this 16:9 shot in a 30-second video clip.

MANDATORY VISUAL STYLE DEFINITION:
${styleDefinition}

CONSISTENT CHARACTER & PROP BIBLE (IDENTICAL ACROSS ALL 4 BEATS):
- Left Character (${characters?.[0]?.name || 'Emma'}): ${bible.emma}
- Right Character (${characters?.[1]?.name || 'Chloe'}): ${bible.chloe}
- Laptop consistency: ${bible.laptopSpec}
- Café setting: ${bible.settingSpec}
- Prohibitions: ${bible.prohibitions.join('; ')}

SCENE & BEAT:
- Place: ${scene?.place || 'University café'}
- Beat (${beat.label}): ${beat.sceneDescription}
- Stored Shot Brief (${storedShot.framing}):
${beatCompositionRule}
- Dialogue context (DO NOT CHANGE): ${beat.dialogue.map((d) => d.line).join(' ')}
${isRegeneration ? `- Provide a fresh subtle camera motion variation compared to: ${JSON.stringify(beat.visualDirection ?? {})}` : ''}

Choose exact allowed values fitting the ${style} style:
- environment: "cafe"
- cameraFraming: one of ["wide", "medium_two_shot", "over_shoulder", "close_up"]
- kenBurns: subtle camera motion (startScale between 1.0 and 1.06, endScale between 1.02 and 1.11, startX/endX between -18 and 18, startY/endY between -8 and 8)
- leftCharacterMood: one of ["neutral", "nervous", "surprised", "happy", "laughing", "embarrassed", "deadpan"]
- rightCharacterMood: one of ["neutral", "nervous", "surprised", "happy", "laughing", "curious", "amused"]
- activeProp: one of ["laptop_slides", "laptop_cat_party", "email_alert", "iced_coffee", "notebook_pen", "smartphone", "none"]
- cutToBlackAtEnd: boolean (${beat.id === 'close' ? 'true' : 'false'})
- visualAccentNote: short 4-8 word visual note referencing the ${style} style and camera shot`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: SCENE_DIRECTION_SCHEMA,
      },
    })
  );

  const parsed = JSON.parse((response.text ?? '{}').trim());
  return { ...parsed, style };
}

// Regenerate ONLY a beat's visual presentation while preserving the exact approved English dialogue.
app.post('/api/storyboard/regenerate-beat-visual', async (req, res) => {
  try {
    const { beat, characters, scene, style, stylePrompt } = req.body;

    if (!beat) {
      res.status(400).json({ error: 'Beat data is required.' });
      return;
    }
    if (!isValidStyle(style)) {
      res.status(400).json({ error: 'A valid visual style selection is required.' });
      return;
    }

    const ai = getAiClient();
    const visualDirection = await generateStyleAwareDirection(
      ai,
      beat,
      characters ?? [],
      scene ?? { place: 'University café' },
      style,
      stylePrompt,
      true
    );

    res.json({ visualDirection });
  } catch (err) {
    const formatted = formatApiError(err, 'visual direction (gemini-4-hydrogen)');
    res.status(formatted.status).json({
      error: formatted.message,
      errorType: formatted.errorType,
      retryAfterSec: formatted.retryAfterSec,
      rawDetail: formatted.rawDetail,
    });
  }
});

const inFlightBeatKeys = new Set<string>();

function streamMp4WithRange(
  req: express.Request,
  res: express.Response,
  filePath: string
) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.status(416).end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (start >= total || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(end - start + 1));
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(total));
  fs.createReadStream(filePath).pipe(res);
}

// Serve cached generated MP4 video clips with HTTP Range support
app.get('/api/video/clip/:style/:filename', (req, res) => {
  const { style, filename } = req.params;
  const filePath = getVideoFilePath(style, filename);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Video clip not found.' });
    return;
  }
  streamMp4WithRange(req, res, filePath);
});

// Serve pre-rendered continuous 30-second master MP4 files with HTTP Range support
app.get('/api/video/master/:style/:filename', (req, res) => {
  const { style, filename } = req.params;
  const filePath = getMasterVideoFilePath(style, filename);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Master video not found.' });
    return;
  }
  streamMp4WithRange(req, res, filePath);
});

// List all completed persistent master MP4s stored in the workspace/bundle vault
app.get('/api/video/masters', (_req, res) => {
  try {
    const masters = listPersistentMasters();
    res.json({ masters });
  } catch (err) {
    const formatted = formatApiError(err, 'list persistent masters');
    res.status(formatted.status).json({ error: formatted.message, masters: [] });
  }
});

// Import/restore a previously downloaded MP4 video into persistent server storage (zero API cost)
app.post(
  '/api/video/import-master',
  express.raw({ type: ['video/mp4', 'application/octet-stream'], limit: '80mb' }),
  (req, res) => {
    try {
      const styleParam =
        typeof req.query.style === 'string'
          ? req.query.style
          : typeof req.headers['x-cinelingo-style'] === 'string'
          ? req.headers['x-cinelingo-style']
          : 'live_action';
      if (!isValidStyle(styleParam)) {
        res.status(400).json({ error: 'Valid visual style is required for video import.' });
        return;
      }
      const mp4Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (mp4Buffer.length < 8192) {
        res.status(400).json({ error: 'Please upload a valid MP4 video file.' });
        return;
      }

      const rawTitle =
        typeof req.query.title === 'string' ? req.query.title.slice(0, 120) : undefined;
      const rawPlace =
        typeof req.query.place === 'string' ? req.query.place.slice(0, 120) : undefined;
      const rawSituation =
        typeof req.query.situation === 'string' ? req.query.situation.slice(0, 400) : undefined;

      const manifest = importMasterMp4Buffer({
        style: styleParam,
        mp4Buffer,
        title: rawTitle,
        scenePlace: rawPlace,
        sceneSituation: rawSituation,
      });

      res.json({ master: manifest });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import MP4 video.';
      res.status(400).json({ error: msg });
    }
  }
);

// Assemble existing cached video clips + cached dialogue audio + end credit into a single continuous MP4
app.post('/api/video/assemble-master', async (req, res) => {
  try {
    const { style, beats, title, scenePlace, sceneSituation } = req.body as {
      style: unknown;
      beats: MasterBeatInput[];
      title?: string;
      scenePlace?: string;
      sceneSituation?: string;
    };

    if (!isValidStyle(style) || !Array.isArray(beats) || beats.length === 0) {
      res.status(400).json({ error: 'Valid visual style and beats are required.' });
      return;
    }

    const sanitizedBeats: MasterBeatInput[] = beats.map((b) => {
      const beatId: BeatId =
        b.beatId === 'hook' || b.beatId === 'problem' || b.beatId === 'turn' || b.beatId === 'close'
          ? b.beatId
          : 'hook';
      return {
        beatId,
        beatDurationSec: Math.max(4, Math.min(20, Number(b.beatDurationSec) || 7)),
        clips: Array.isArray(b.clips) ? b.clips : [],
        subtitleCues: Array.isArray(b.subtitleCues) ? b.subtitleCues : [],
        audioBase64: typeof b.audioBase64 === 'string' ? b.audioBase64 : '',
        cutToBlackAtEnd: Boolean(b.cutToBlackAtEnd),
        hasLaughTrack: Boolean(b.hasLaughTrack),
      };
    });

    const result = await assembleMasterVideo({
      style,
      beats: sanitizedBeats,
      title: typeof title === 'string' ? title : undefined,
      scenePlace: typeof scenePlace === 'string' ? scenePlace : undefined,
      sceneSituation: typeof sceneSituation === 'string' ? sceneSituation : undefined,
    });
    const completedMaster = getPersistentMasterForStyle(style);
    res.json({ ...result, completedMaster });
  } catch (err) {
    const formatted = formatApiError(err, 'master video assembly');
    res.status(formatted.status).json({
      error: formatted.message,
      rawDetail: formatted.rawDetail,
    });
  }
});

// Zero-cost check for cached moving video clips, persistent masters, and cached audio on disk
app.post('/api/video/check-cache', (req, res) => {
  try {
    const { beats, characters, scene, style } = req.body as {
      beats: Array<{
        id: BeatId;
        startSec?: number;
        endSec?: number;
        sceneDescription: string;
        dialogue: Array<{ speaker: string; line: string }>;
      }>;
      characters?: Array<{ name: string; voiceName: string }>;
      scene: { place: string; situation: string };
      style: unknown;
    };
    if (!Array.isArray(beats) || !isValidStyle(style)) {
      res.status(400).json({ error: 'Valid beats and style are required.' });
      return;
    }

    const laughWavPath = path.resolve('src/assets/audio/sitcom_audience_laugh.wav');
    const cachedLaughBuffer = fs.existsSync(laughWavPath)
      ? fs.readFileSync(laughWavPath)
      : null;

    const persistentMaster = getPersistentMasterForStyle(style);

    const cachedByBeat: Record<
      string,
      {
        videoClips: ReturnType<typeof getCachedBeatVideoSegments>;
        pendingOperation?: { interactionId: string; pendingClipLabel: string } | null;
        cachedAudio?: {
          audioBase64: string;
          audioDurationSec: number;
          dialogueAudioBase64: string;
          dialogueDurationSec: number;
          subtitleCues: Array<{ speaker: string; text: string; startSec: number; endSec: number }>;
          hasLaughTrack: boolean;
        };
      }
    > = {};

    for (const b of beats) {
      const beatId: BeatId =
        b.id === 'hook' || b.id === 'problem' || b.id === 'turn' || b.id === 'close'
          ? b.id
          : 'hook';
      const rawClips = getCachedBeatVideoSegments({
        style,
        beatId,
        scenePlace: scene?.place || 'University café',
        sceneSituation: scene?.situation || '',
        sceneDescription: b.sceneDescription || '',
        dialogueLines: b.dialogue || [],
      });

      const masterBeatWindow = persistentMaster?.beatStarts?.[beatId];
      const hasRecoveredFromMaster = Boolean(!rawClips && persistentMaster && masterBeatWindow);

      if (!rawClips && !hasRecoveredFromMaster) {
        const pendingOp = getBeatPendingOperationInfo({
          style,
          beatId,
          scenePlace: scene?.place || 'University café',
          sceneSituation: scene?.situation || '',
          sceneDescription: b.sceneDescription || '',
          dialogueLines: b.dialogue || [],
        });
        if (pendingOp) {
          cachedByBeat[beatId] = { videoClips: null, pendingOperation: pendingOp };
        }
        continue;
      }

      const cleanTurns = (b.dialogue || []).filter((d) => d.line.trim().length > 0);
      const turnVoiceSpecs = cleanTurns.map((t) => ({
        speaker: t.speaker,
        line: t.line.trim(),
        voiceName: getVoiceForSpeaker(t.speaker, characters ?? []),
      }));
      const diskAudio = getCachedDialogueAudio(beatId, turnVoiceSpecs);
      let cachedAudio:
        | {
            audioBase64: string;
            audioDurationSec: number;
            dialogueAudioBase64: string;
            dialogueDurationSec: number;
            subtitleCues: Array<{ speaker: string; text: string; startSec: number; endSec: number }>;
            hasLaughTrack: boolean;
          }
        | undefined;

      if (diskAudio?.dialogueAudioBase64) {
        if (style === 'live_action' && beatId === 'problem') {
          if (cachedLaughBuffer) {
            const parsedDialogue = parseWavBuffer(
              Buffer.from(diskAudio.dialogueAudioBase64, 'base64')
            );
            const parsedLaugh = parseWavBuffer(cachedLaughBuffer);
            const targetBeatSec = Math.max(4, (b.endSec ?? 15) - (b.startSec ?? 7));
            const mixed = mixStudioLaughAfterDialogue({
              dialoguePcm: parsedDialogue.pcmData,
              laughPcm: parsedLaugh.pcmData,
              sampleRate: parsedDialogue.sampleRate,
              channels: parsedDialogue.channels,
              bitsPerSample: parsedDialogue.bitsPerSample,
              targetBeatDurationSec: targetBeatSec,
            });
            const mixedWav = buildWavFromPcm(
              [mixed.combinedPcm],
              parsedDialogue.sampleRate,
              parsedDialogue.channels,
              parsedDialogue.bitsPerSample
            );
            cachedAudio = {
              audioBase64: mixedWav.toString('base64'),
              audioDurationSec: mixed.totalDurationSec,
              dialogueAudioBase64: diskAudio.dialogueAudioBase64,
              dialogueDurationSec: diskAudio.dialogueDurationSec,
              subtitleCues: diskAudio.subtitleCues,
              hasLaughTrack: true,
            };
          }
        } else {
          cachedAudio = {
            audioBase64: diskAudio.dialogueAudioBase64,
            audioDurationSec: diskAudio.dialogueDurationSec,
            dialogueAudioBase64: diskAudio.dialogueAudioBase64,
            dialogueDurationSec: diskAudio.dialogueDurationSec,
            subtitleCues: diskAudio.subtitleCues,
            hasLaughTrack: false,
          };
        }
      } else if (persistentMaster && masterBeatWindow) {
        const extracted = extractBeatAudioFromMaster({
          style,
          beatId,
          startSec: masterBeatWindow.startSec,
          endSec: masterBeatWindow.endSec,
        });
        const masterCues = persistentMaster.subtitleCuesByBeat?.[beatId];
        const fallbackCues =
          masterCues && masterCues.length > 0
            ? masterCues
            : buildPhraseSubtitleCues(b.dialogue || [], masterBeatWindow.durationSec);
        if (extracted?.audioBase64) {
          cachedAudio = {
            audioBase64: extracted.audioBase64,
            audioDurationSec: extracted.audioDurationSec,
            dialogueAudioBase64: extracted.audioBase64,
            dialogueDurationSec: extracted.audioDurationSec,
            subtitleCues: fallbackCues,
            hasLaughTrack: Boolean(
              persistentMaster.hasLaughTrackByBeat?.[beatId] ??
                (style === 'live_action' && beatId === 'problem')
            ),
          };
        }
      }

      const endPaddingSec = beatId === 'close' ? 1.15 : 0.25;
      const baseBeatSec = Math.max(5, (b.endSec ?? 8) - (b.startSec ?? 0));
      const audioDur = cachedAudio?.audioDurationSec ?? baseBeatSec;
      const effectiveDuration = Number(Math.max(baseBeatSec, audioDur + endPaddingSec).toFixed(2));

      if (rawClips) {
        const syncedClips = synchronizeBeatClipsWithAudio({
          style,
          beatId,
          clips: rawClips,
          subtitleCues: cachedAudio?.subtitleCues,
          dialogueDurationSec: cachedAudio?.dialogueDurationSec,
          beatTargetDurationSec: effectiveDuration,
        });
        cachedByBeat[beatId] = { videoClips: syncedClips, cachedAudio };
      } else if (persistentMaster && masterBeatWindow) {
        cachedByBeat[beatId] = {
          videoClips: [
            {
              url: persistentMaster.cleanUrl,
              durationSec: masterBeatWindow.durationSec,
              actualDurationSec: persistentMaster.totalDurationSec,
              trimStartSec: masterBeatWindow.startSec,
              trimEndSec: masterBeatWindow.endSec,
              playbackRate: 1,
              syncVersion: 2,
              label: `${b.id} (Persistent Master)`,
            },
          ],
          cachedAudio,
        };
      }
    }
    res.json({ cachedByBeat, completedMaster: persistentMaster });
  } catch {
    res.json({ cachedByBeat: {}, completedMaster: null });
  }
});

// Zero-cost read-only check verifying API version and model availability for connected project
app.get('/api/video/verify-model-access', async (_req, res) => {
  try {
    const hasKey = Boolean(process.env.GEMINI_API_KEY);
    if (!hasKey) {
      res.status(500).json({ hasKey: false, error: 'GEMINI_API_KEY is not set.' });
      return;
    }

    const v1Client = getAiClient();
    const v1betaClient = createVideoAiClient();

    const checkModel = async (client: GoogleGenAI, model: string) => {
      try {
        const info = await client.models.get({ model });
        return {
          available: true,
          name: info.name,
          displayName: info.displayName,
          supportedActions: info.supportedActions ?? [],
        };
      } catch (err: unknown) {
        return {
          available: false,
          error: getRawErrorString(err),
        };
      }
    };

    const [
      v1Omni,
      v1betaOmni,
      v1LiteTts,
      v1betaLiteTts,
      v1FlashTts,
      v1betaFlashTts,
      v1Hydrogen,
      v1betaHydrogen,
    ] = await Promise.all([
      checkModel(v1Client, 'gemini-omni-1.2-flash'),
      checkModel(v1betaClient, 'gemini-omni-1.2-flash'),
      checkModel(v1Client, 'gemini-3.8-flash-lite-tts'),
      checkModel(v1betaClient, 'gemini-3.8-flash-lite-tts'),
      checkModel(v1Client, 'gemini-3.8-flash-tts'),
      checkModel(v1betaClient, 'gemini-3.8-flash-tts'),
      checkModel(v1Client, 'gemini-4-hydrogen'),
      checkModel(v1betaClient, 'gemini-4-hydrogen'),
    ]);

    const videoModelsInV1Beta: Array<{
      name: string;
      displayName?: string;
      supportedActions?: string[];
    }> = [];
    const listPager = await v1betaClient.models.list({ config: { pageSize: 100 } });
    for await (const m of listPager) {
      const name = (m.name || '').toLowerCase();
      const actions = (m.supportedActions || []).join(',').toLowerCase();
      if (
        name.includes('omni') ||
        name.includes('veo') ||
        name.includes('video') ||
        actions.includes('predictlongrunning') ||
        actions.includes('generatevideos')
      ) {
        videoModelsInV1Beta.push({
          name: m.name || '',
          displayName: m.displayName,
          supportedActions: m.supportedActions,
        });
      }
    }

    const clientInternal = (v1betaClient as unknown as {
      apiClient?: { getApiVersion?: () => string; getBaseUrl?: () => string };
    }).apiClient;

    res.json({
      hasKey: true,
      videoClientApiVersion: clientInternal?.getApiVersion?.() ?? 'unknown',
      videoClientBaseUrl: clientInternal?.getBaseUrl?.() ?? 'unknown',
      v1Check: v1Omni,
      v1betaCheck: v1betaOmni,
      ttsChecks: {
        v1LiteTts,
        v1betaLiteTts,
        v1FlashTts,
        v1betaFlashTts,
      },
      textChecks: {
        v1Hydrogen,
        v1betaHydrogen,
      },
      videoModelsInV1Beta,
    });
  } catch (err) {
    res.status(500).json({ error: getRawErrorString(err) });
  }
});

app.post('/api/video/generate-beat', async (req, res) => {
  let activeStage = 'request validation';
  let dedupeKey = '';
  try {
    const {
      beat,
      characters,
      scene,
      style,
      stylePrompt,
      existingDialogueAudio,
      audioOnly = false,
    } = req.body as {
      beat: {
        id: string;
        label: string;
        startSec: number;
        endSec: number;
        sceneDescription: string;
        dialogue: Array<{ speaker: string; line: string }>;
        visualDirection?: Record<string, unknown> & { style?: string };
      };
      characters: Array<{ name: string; voiceName: string; role: string }>;
      scene: { place: string; situation: string };
      style: unknown;
      stylePrompt?: string;
      audioOnly?: boolean;
      existingDialogueAudio?: {
        audioBase64: string;
        audioDurationSec: number;
        subtitleCues: Array<{ speaker: string; text: string; startSec: number; endSec: number }>;
      };
    };

    if (!beat) {
      res.status(400).json({ error: 'Beat data is required.' });
      return;
    }
    if (!isValidStyle(style)) {
      res.status(400).json({
        error: 'A valid visual style must be selected before generating clips.',
      });
      return;
    }

    dedupeKey = `${beat.id}:${style}:${audioOnly ? 'audio' : 'full'}`;
    if (inFlightBeatKeys.has(dedupeKey)) {
      res.status(409).json({
        error: 'A generation request for this scene is already running.',
        errorType: 'rate_limit',
      });
      return;
    }
    inFlightBeatKeys.add(dedupeKey);

    const ai = getAiClient();
    const targetDurationSec = Math.max(4, beat.endSec - beat.startSec);
    const beatId: BeatId =
      beat.id === 'hook' || beat.id === 'problem' || beat.id === 'turn' || beat.id === 'close'
        ? beat.id
        : 'hook';

    // Step 1: Never call Gemini for visual direction if local/matching style direction is already present
    const hasMatchingStyleDirection =
      beat.visualDirection &&
      (beat.visualDirection.style === style ||
        (beat.visualDirection.cameraFraming && beat.visualDirection.kenBurns));

    let sceneDirection = beat.visualDirection
      ? { ...beat.visualDirection, style }
      : undefined;
    if (!hasMatchingStyleDirection) {
      activeStage = 'scene direction (gemini-4-hydrogen)';
      sceneDirection = await generateStyleAwareDirection(
        ai,
        beat,
        characters ?? [],
        scene,
        style,
        stylePrompt,
        false
      );
      await new Promise((r) => setTimeout(r, 200));
    }

    // Step 2: Check client-provided dry audio OR server persistent disk cache BEFORE calling TTS
    const cleanTurns = beat.dialogue.filter((d) => d.line.trim().length > 0);
    const turnVoiceSpecs = cleanTurns.map((t) => ({
      speaker: t.speaker,
      line: t.line.trim(),
      voiceName: getVoiceForSpeaker(t.speaker, characters ?? []),
    }));
    const shouldIncludeSitcomLaugh = style === 'live_action' && beatId === 'problem';

    let dryDialogueAudioBase64 = '';
    let dryDialogueDurationSec = targetDurationSec;
    let subtitleCues: Array<{ speaker: string; text: string; startSec: number; endSec: number }> =
      [];

    if (cleanTurns.length === 0) {
      dryDialogueAudioBase64 = '';
      dryDialogueDurationSec = targetDurationSec;
      subtitleCues = [];
    } else if (
      existingDialogueAudio?.audioBase64 &&
      Array.isArray(existingDialogueAudio.subtitleCues)
    ) {
      dryDialogueAudioBase64 = existingDialogueAudio.audioBase64;
      dryDialogueDurationSec = existingDialogueAudio.audioDurationSec;
      subtitleCues = existingDialogueAudio.subtitleCues;
      saveCachedDialogueAudio(beat.id, turnVoiceSpecs, {
        dialogueAudioBase64: dryDialogueAudioBase64,
        dialogueDurationSec: dryDialogueDurationSec,
        subtitleCues,
      });
    } else {
      const diskCached = getCachedDialogueAudio(beat.id, turnVoiceSpecs);
      if (diskCached) {
        dryDialogueAudioBase64 = diskCached.dialogueAudioBase64;
        dryDialogueDurationSec = diskCached.dialogueDurationSec;
        subtitleCues = diskCached.subtitleCues;
      } else {
        activeStage = 'voice generation (gemini-3.8-flash-lite-tts)';
        const audioAi = createAudioAiClient();
        const turnResults: Array<{
          speaker: string;
          line: string;
          parsed: ParsedWav;
        }> = [];

        for (let tIdx = 0; tIdx < turnVoiceSpecs.length; tIdx++) {
          const turn = turnVoiceSpecs[tIdx];
          if (tIdx > 0) {
            await new Promise((r) => setTimeout(r, 250));
          }

          const ttsResp = await withRetry(() =>
            audioAi.models.generateContent({
              model: 'gemini-3.8-flash-lite-tts',
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: turn.line,
                      speechMetadata: {
                        style:
                          beatId === 'close' && turn.speaker.toLowerCase() === 'emma'
                            ? 'Happy, lightly amused, warm American college delivery, relaxed and natural'
                            : 'Natural expressive American college student, clear sitcom pacing',
                      },
                    },
                  ],
                },
              ],
              config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: turn.voiceName },
                  },
                },
              },
            })
          );

          const b64 =
            ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? '';
          if (!b64) {
            throw new Error('Speech generation returned empty audio for a dialogue line.');
          }

          const parsed = parseWavBuffer(Buffer.from(b64, 'base64'));
          turnResults.push({
            speaker: turn.speaker,
            line: turn.line,
            parsed,
          });
        }

        const baseSampleRate = turnResults[0].parsed.sampleRate;
        const baseChannels = turnResults[0].parsed.channels;
        const baseBits = turnResults[0].parsed.bitsPerSample;
        const pauseSec = 0.22;
        const pauseBytes =
          Math.round(baseSampleRate * pauseSec) * baseChannels * (baseBits / 8);
        const silenceBuf = Buffer.alloc(pauseBytes);

        const pcmChunks: Buffer[] = [];
        let cursorSec = 0;
        turnResults.forEach((tr, idx) => {
          if (idx > 0) {
            pcmChunks.push(silenceBuf);
            cursorSec += pauseSec;
          }
          pcmChunks.push(tr.parsed.pcmData);

          const turnDuration = Math.max(0.6, tr.parsed.durationSec);
          const alignedCues = alignPhrasesToTurnPcm({
            pcmData: tr.parsed.pcmData,
            sampleRate: tr.parsed.sampleRate,
            channels: tr.parsed.channels,
            bitsPerSample: tr.parsed.bitsPerSample,
            turnOffsetSec: cursorSec,
            turnDurationSec: turnDuration,
            speaker: tr.speaker,
            line: tr.line,
          });
          subtitleCues.push(...alignedCues);

          cursorSec += turnDuration;
        });

        const dryWav = buildWavFromPcm(
          pcmChunks,
          baseSampleRate,
          baseChannels,
          baseBits
        );
        dryDialogueAudioBase64 = dryWav.toString('base64');
        dryDialogueDurationSec = Number(cursorSec.toFixed(2));

        // Persist dry character dialogue permanently on disk across all styles
        saveCachedDialogueAudio(beat.id, turnVoiceSpecs, {
          dialogueAudioBase64: dryDialogueAudioBase64,
          dialogueDurationSec: dryDialogueDurationSec,
          subtitleCues,
        });
      }
    }

    // Step 3: Apply sitcom audience laugh ONLY for live_action Beat 2, reusing cached laugh WAV
    let finalAudioBase64 = dryDialogueAudioBase64;
    let finalAudioDurationSec = dryDialogueDurationSec;
    let hasLaughTrack = false;

    if (shouldIncludeSitcomLaugh && dryDialogueAudioBase64) {
      activeStage = 'sitcom audience laugh track (gemini-3.8-flash-tts)';
      const audioAi = createAudioAiClient();
      const parsedDialogue = parseWavBuffer(Buffer.from(dryDialogueAudioBase64, 'base64'));
      const laughPcm = await withRetry(() => getOrCreateStudioLaughTrack(audioAi));
      const mixed = mixStudioLaughAfterDialogue({
        dialoguePcm: parsedDialogue.pcmData,
        laughPcm,
        sampleRate: parsedDialogue.sampleRate,
        channels: parsedDialogue.channels,
        bitsPerSample: parsedDialogue.bitsPerSample,
        targetBeatDurationSec: targetDurationSec,
      });
      const mixedWav = buildWavFromPcm(
        [mixed.combinedPcm],
        parsedDialogue.sampleRate,
        parsedDialogue.channels,
        parsedDialogue.bitsPerSample
      );
      finalAudioBase64 = mixedWav.toString('base64');
      finalAudioDurationSec = mixed.totalDurationSec;
      hasLaughTrack = true;
    }

    // Step 4: Non-blocking start or recovery of background moving-character MP4 clips (gemini-omni-1.2-flash)
    let videoClips: Array<{
      url: string;
      durationSec: number;
      trimStartSec?: number;
      trimEndSec?: number;
      label?: string;
    }> = [];
    let hasMovingVideo = false;
    let videoStatus: 'ready' | 'pending' | 'audio_only' = audioOnly ? 'audio_only' : 'pending';
    let pendingClipLabel: string | undefined;
    let interactionId: string | undefined;
    let completedClips = 0;
    let totalClips = beatId === 'problem' ? 2 : 1;

    if (!audioOnly) {
      activeStage = 'moving video generation (gemini-omni-1.2-flash)';
      const videoAi = createVideoAiClient();
      const turnTimings = deriveSpeakerTurnTimings(cleanTurns, subtitleCues);
      const videoResult = await advanceBeatVideoGeneration({
        ai: videoAi,
        style,
        beatId,
        scenePlace: scene?.place || 'University café',
        sceneSituation: scene?.situation || '',
        sceneDescription: beat.sceneDescription || '',
        dialogueLines: cleanTurns,
        turnTimings,
      });
      videoClips = videoResult.segments;
      videoStatus = videoResult.status;
      pendingClipLabel = videoResult.pendingClipLabel;
      interactionId = videoResult.interactionId;
      completedClips = videoResult.completedClips;
      totalClips = videoResult.totalClips;
      hasMovingVideo = videoResult.status === 'ready' && videoClips.length > 0;
    }

    // Ensure Beat 4 leaves clean room after Emma finishes speaking for Cut to Black & End Credit
    const endPaddingSec = beatId === 'close' ? 1.15 : 0.25;
    const effectiveDuration = Number(
      Math.max(targetDurationSec, finalAudioDurationSec + endPaddingSec).toFixed(2)
    );

    if (hasMovingVideo && videoClips.length > 0) {
      videoClips = synchronizeBeatClipsWithAudio({
        style,
        beatId,
        clips: videoClips,
        subtitleCues,
        dialogueDurationSec: dryDialogueDurationSec,
        beatTargetDurationSec: effectiveDuration,
      });
    }

    res.json({
      beatId: beat.id,
      styleApplied: style,
      hasLaughTrack,
      videoStatus,
      hasMovingVideo,
      videoClips,
      pendingClipLabel,
      interactionId,
      completedClips,
      totalClips,
      sceneDirection,
      audioBase64: finalAudioBase64,
      audioDurationSec: finalAudioDurationSec,
      dialogueAudioBase64: dryDialogueAudioBase64,
      dialogueDurationSec: dryDialogueDurationSec,
      targetDurationSec: Number(effectiveDuration.toFixed(2)),
      subtitleCues,
    });
  } catch (err) {
    const formatted = formatApiError(err, activeStage);
    res.status(formatted.status).json({
      error: formatted.message,
      errorType: formatted.errorType,
      retryAfterSec: formatted.retryAfterSec,
      rawDetail: formatted.rawDetail,
    });
  } finally {
    if (dedupeKey) {
      inFlightBeatKeys.delete(dedupeKey);
    }
  }
});

// Fast non-blocking polling endpoint for background gemini-omni-1.2-flash operations
app.post('/api/video/poll-beat', async (req, res) => {
  let pollKey = '';
  try {
    const { beat, scene, style, subtitleCues, targetDurationSec } = req.body as {
      beat: {
        id: string;
        startSec?: number;
        endSec?: number;
        sceneDescription: string;
        dialogue: Array<{ speaker: string; line: string }>;
      };
      scene: { place: string; situation: string };
      style: unknown;
      subtitleCues?: Array<{ speaker: string; text: string; startSec: number; endSec: number }>;
      targetDurationSec?: number;
    };

    if (!beat || !isValidStyle(style)) {
      res.status(400).json({ error: 'Valid beat and style are required for video polling.' });
      return;
    }

    const beatId: BeatId =
      beat.id === 'hook' || beat.id === 'problem' || beat.id === 'turn' || beat.id === 'close'
        ? beat.id
        : 'hook';

    pollKey = `${beatId}:${style}:poll`;
    if (inFlightBeatKeys.has(pollKey)) {
      res.json({
        beatId,
        styleApplied: style,
        videoStatus: 'pending',
        hasMovingVideo: false,
        videoClips: [],
      });
      return;
    }
    inFlightBeatKeys.add(pollKey);

    const videoAi = createVideoAiClient();
    const cleanTurns = (beat.dialogue || []).filter((d) => d.line.trim().length > 0);
    const turnTimings = deriveSpeakerTurnTimings(cleanTurns, subtitleCues || []);

    const videoResult = await advanceBeatVideoGeneration({
      ai: videoAi,
      style,
      beatId,
      scenePlace: scene?.place || 'University café',
      sceneSituation: scene?.situation || '',
      sceneDescription: beat.sceneDescription || '',
      dialogueLines: cleanTurns,
      turnTimings,
    });

    const isReady = videoResult.status === 'ready' && videoResult.segments.length > 0;
    const baseBeatSec = Math.max(5, (beat.endSec ?? 8) - (beat.startSec ?? 0));
    const effectiveDur =
      typeof targetDurationSec === 'number' && targetDurationSec > 0
        ? targetDurationSec
        : baseBeatSec;

    const finalSegments = isReady
      ? synchronizeBeatClipsWithAudio({
          style,
          beatId,
          clips: videoResult.segments,
          subtitleCues,
          beatTargetDurationSec: effectiveDur,
        })
      : videoResult.segments;

    res.json({
      beatId,
      styleApplied: style,
      videoStatus: videoResult.status,
      hasMovingVideo: isReady,
      videoClips: finalSegments,
      pendingClipLabel: videoResult.pendingClipLabel,
      interactionId: videoResult.interactionId,
      completedClips: videoResult.completedClips,
      totalClips: videoResult.totalClips,
    });
  } catch (err) {
    const formatted = formatApiError(err, 'moving video generation (gemini-omni-1.2-flash)');
    res.status(formatted.status).json({
      error: formatted.message,
      errorType: formatted.errorType,
      retryAfterSec: formatted.retryAfterSec,
      rawDetail: formatted.rawDetail,
    });
  } finally {
    if (pollKey) {
      inFlightBeatKeys.delete(pollKey);
    }
  }
});

// Guarantee all /api/* routes return JSON (never fall through to SPA HTML or HTML error pages)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (req.path.startsWith('/api')) {
      const formatted = formatApiError(err, req.path);
      res.status(formatted.status).json({
        error: formatted.message,
        errorType: formatted.errorType,
        rawDetail: formatted.rawDetail,
      });
      return;
    }
    next(err);
  }
);

async function startServer() {
  const distPath = path.resolve('dist');
  const isProd =
    process.env.NODE_ENV === 'production' ||
    (process.env.npm_lifecycle_event === 'start' && fs.existsSync(distPath));

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CineLingo server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
