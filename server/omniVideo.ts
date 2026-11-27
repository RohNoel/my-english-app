import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import {
  CHARACTER_PROP_CONSISTENCY_BY_STYLE,
  STORED_SHOT_BRIEFS,
  UPDATED_STYLE_BRIEFS,
} from '../src/data/visualRegenerationSpec.ts';
import type { BeatId, VideoClipSegment, VisualStyleId } from '../src/types.ts';
import {
  clearPendingVideoOperation,
  computeVideoPromptHash,
  getCachedVideoClip,
  getPendingVideoOperation,
  saveCachedVideoClip,
  savePendingVideoOperation,
} from './videoCache.ts';

export function createVideoAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function ensureV1BetaVideoClient(ai?: GoogleGenAI): GoogleGenAI {
  const currentVersion = (
    ai as unknown as { apiClient?: { getApiVersion?: () => string } } | undefined
  )?.apiClient?.getApiVersion?.();
  if (ai && currentVersion === 'v1beta') {
    return ai;
  }
  return createVideoAiClient();
}

const PROBLEM_INSERT_IMAGE_PATHS: Record<VisualStyleId, string> = {
  live_action: '/src/assets/images/live_problem_insert_v2_1795683967234.jpg',
  '3d_animation': '/src/assets/images/anim3d_problem_insert_v2_1795679558526.jpg',
  '2d_animation': '/src/assets/images/anim2d_problem_insert_v3_1795681904400.jpg',
  american_comic: '/src/assets/images/comic_problem_insert_v2_1795679610406.jpg',
};

const STYLE_MOTION_DIRECTIVES: Record<VisualStyleId, string> = {
  live_action:
    'Make it look like an actual American television sitcom, with natural human acting, realistic body movements, conversational timing, blinking, expressive head turns, subtle hand gestures, and lip-synced speaking motion in bright high-key TV studio lighting. Strictly avoid the look of a commercial, stock footage, or romantic drama.',
  '3d_animation':
    'Create smooth, expressive 3D character animation preserving the approved character proportions, youthful college facial features, and clean neutral-to-warm palette, with natural body weight, blinking, expressive eye/facial movements, hand gestures, and convincing character interactions.',
  '2d_animation':
    'Make it look like an actual American television 2D cartoon, preserving the approved graphic shapes, character designs, bold clean ink outlines, and flat cel color palette, with lively character movements, blinking, hand gestures, and clear animated mouth/lip movements.',
  american_comic:
    'Bring the American comic-book characters to life through actual animated facial expressions, blinking, hand gestures, head turns, and speaking mouth movements while strictly preserving the crisp ink outlines, colors, halftone textures, and clean graphic-novel paper aesthetic. Do not simply pan across static comic panels, and never add speech bubbles.',
};

export interface TurnTiming {
  speaker: string;
  line: string;
  startSec: number;
  endSec: number;
}

interface SubClipSpec {
  part: 'main' | 'insert' | 'return';
  durationTag: '3s' | '7s' | '8s' | '9s';
  durationSec: number;
  trimStartSec?: number;
  trimEndSec?: number;
  label: string;
  referenceImageAssetPath: string;
  hashPrompt: string;
  prompt: string;
}

function loadAssetImageBase64(assetPath: string): {
  base64: string;
  mimeType: string;
} {
  const rel = assetPath.replace(/^\/+/, '');
  const resolved = path.resolve(rel);
  const assetsRoot = path.resolve('src/assets/images');
  if (!resolved.startsWith(assetsRoot + path.sep) || !fs.existsSync(resolved)) {
    throw new Error(`Storyboard reference image missing: ${assetPath}`);
  }
  const buf = fs.readFileSync(resolved);
  return {
    base64: buf.toString('base64'),
    mimeType: resolved.endsWith('.png') ? 'image/png' : 'image/jpeg',
  };
}

function formatTurnTimingGuidance(
  turnTimings: TurnTiming[] | undefined,
  clipOffsetSec = 0
): string {
  if (!turnTimings || turnTimings.length === 0) return '';
  const windows = turnTimings
    .map((t) => {
      const start = Math.max(0, Number((t.startSec - clipOffsetSec).toFixed(1)));
      const end = Math.max(start + 0.4, Number((t.endSec - clipOffsetSec).toFixed(1)));
      return `- ${start.toFixed(1)}s to ${end.toFixed(1)}s: ${t.speaker} is actively speaking ("${t.line}") with natural mouth/lip articulation, blinking, and gestures while the other friend listens and reacts naturally.`;
    })
    .join('\n');
  return `\nLIP-SYNC SPEAKING WINDOWS (match mouth movement and reactions to these times; do NOT render any text):\n${windows}`;
}

function buildSubClipSpecs(params: {
  style: VisualStyleId;
  beatId: BeatId;
  scenePlace: string;
  sceneSituation: string;
  sceneDescription: string;
  dialogueLines: Array<{ speaker: string; line: string }>;
  turnTimings?: TurnTiming[];
}): SubClipSpec[] {
  const { style, beatId, scenePlace, sceneDescription, dialogueLines, turnTimings } = params;
  const bible = CHARACTER_PROP_CONSISTENCY_BY_STYLE[style];
  const styleHeader = UPDATED_STYLE_BRIEFS[style];
  const motionDirective = STYLE_MOTION_DIRECTIVES[style];
  const mainRefPath = STORED_SHOT_BRIEFS[style][beatId].targetAssetPath;

  const dialogueSummary = dialogueLines
    .map((d) => `${d.speaker} says "${d.line}"`)
    .join(' Then ');

  const sharedContinuityLock = [
    `VISUAL STYLE: ${styleHeader}`,
    `ANIMATION & ACTING: ${motionDirective}`,
    `CHARACTER IDENTITIES (LOCKED):`,
    `- Emma (left): ${bible.emma}`,
    `- Chloe (right): ${bible.chloe}`,
    `- Laptop & Props: ${bible.laptopSpec}`,
    `- Café Environment (${scenePlace || 'University café'}): ${bible.settingSpec}`,
    `CONTINUITY & NEGATIVE CONSTRAINTS: Keep the exact same characters, facial features, hairstyles (Chloe long blonde hair, Emma long dark brown hair, neither wearing glasses), outfits, props, café background, furniture, and lighting from the reference image. Do NOT render any subtitles, captions, speech bubbles, floating text, or brand logos. Silent video output (voice audio is synced separately), with natural talking mouth motion strictly during speaking turns.`,
  ].join('\n');

  if (beatId === 'hook') {
    const hashPrompt = [
      `SCENE 1 — HOOK (0–7s): Animate directly from the reference storyboard frame.`,
      `ACTION & EMOTIONAL PROGRESSION:`,
      `- Emma looks nervous, slightly panicked, and worried, glancing anxiously toward her open laptop and shifting nervously in her seat with subtle anxious hand movements and blinking.`,
      `- Chloe notices Emma's nervous behavior, gently puts down her iced coffee cup on the table, leans forward with curiosity and mild concern, and asks Emma about it while speaking naturally.`,
      `- Emma avoids steady eye contact at first, then responds nervously with expressive head and hand movements.`,
      `SPEAKING RHYTHM CONTEXT (do not display text): ${dialogueSummary}`,
      `CUSTOM SCENE NOTE: ${sceneDescription}`,
      sharedContinuityLock,
    ].join('\n');

    return [
      {
        part: 'main',
        durationTag: '8s',
        durationSec: 8,
        label: 'Hook',
        referenceImageAssetPath: mainRefPath,
        hashPrompt,
        prompt: `${hashPrompt}${formatTurnTimingGuidance(turnTimings)}`,
      },
    ];
  }

  if (beatId === 'problem') {
    const insertRefPath = PROBLEM_INSERT_IMAGE_PATHS[style];
    const insertHashPrompt = [
      `SCENE 2A — LAPTOP CLOSE-UP INSERT (~1.75s): Animate directly from the close-up laptop reference image.`,
      `ACTION: Brief close-up of the open matte-silver laptop on the café table displaying the colorful birthday slideshow of an orange tabby cat wearing a tiny party hat. Subtle animated party sparkles/slideshow motion on the physical screen and gentle hand motion at the edge of the laptop as it finishes turning toward Chloe. Keep the exact café table surface, coffee cup, and lighting consistent.`,
      sharedContinuityLock,
    ].join('\n');

    const returnHashPrompt = [
      `SCENE 2B — PROBLEM RETURN TWO-SHOT: Animate directly from the two-shot reference frame with Emma and Chloe looking at the angled laptop.`,
      `ACTION & EMOTIONAL PROGRESSION:`,
      `- Emma explains her mistake to Chloe with expressive hand gestures and apologetic speaking mouth movements. Emma looks extremely embarrassed, with ONLY a subtle, natural light blush on her cheeks or ears (strictly avoid excessive facial redness).`,
      `- Chloe looks at the cat slideshow on the laptop screen and smiles warmly with amusement, naturally trying not to laugh (subtle suppressed chuckle, raised eyebrows, head tilt).`,
      `- Include natural blinking, head turns, and interactive body language between both friends.`,
      `SPEAKING RHYTHM CONTEXT (do not display text): ${dialogueSummary}`,
      `CUSTOM SCENE NOTE: ${sceneDescription}`,
      sharedContinuityLock,
    ].join('\n');

    return [
      {
        part: 'insert',
        durationTag: '3s',
        durationSec: 3,
        trimStartSec: 0,
        trimEndSec: 1.75,
        label: 'Laptop Slideshow Insert',
        referenceImageAssetPath: insertRefPath,
        hashPrompt: insertHashPrompt,
        prompt: insertHashPrompt,
      },
      {
        part: 'return',
        durationTag: '7s',
        durationSec: 7,
        trimStartSec: 0,
        label: 'Problem Reaction Two-Shot',
        referenceImageAssetPath: mainRefPath,
        hashPrompt: returnHashPrompt,
        prompt: `${returnHashPrompt}${formatTurnTimingGuidance(turnTimings, 1.75)}`,
      },
    ];
  }

  if (beatId === 'turn') {
    const hashPrompt = [
      `SCENE 3 — TURN (15–23s): Animate directly from the reference storyboard frame.`,
      `ACTION & EMOTIONAL PROGRESSION:`,
      `- Chloe leans toward the laptop screen, notices the professor's email notification/reply, and reacts with a natural silent "Oh!" expression of pleasant surprise (eyes brightening, eyebrows lifting, warm delighted smile — visual reaction only, do NOT invent extra spoken words), then reads the message aloud with expressive speaking mouth movements and hand gestures.`,
      `- Emma sits beside her initially still looking embarrassed and tense, and as she hears Chloe read the professor's reply, Emma's facial expression gradually and visibly transitions within this single continuous shot to surprise, relief, and amused delight.`,
      `- Show these emotional shifts smoothly and naturally inside the shot with blinking and natural posture changes.`,
      `SPEAKING RHYTHM CONTEXT (do not display text): ${dialogueSummary}`,
      `CUSTOM SCENE NOTE: ${sceneDescription}`,
      sharedContinuityLock,
    ].join('\n');

    return [
      {
        part: 'main',
        durationTag: '9s',
        durationSec: 9,
        label: 'Turn',
        referenceImageAssetPath: mainRefPath,
        hashPrompt,
        prompt: `${hashPrompt}${formatTurnTimingGuidance(turnTimings)}`,
      },
    ];
  }

  // Beat 4: Close
  const hashPrompt = [
    `SCENE 4 — CLOSE (23–30s): Animate directly from the reference storyboard frame.`,
    `ACTION & EMOTIONAL PROGRESSION:`,
    `- Emma looks genuinely happy and lightly amused (natural, warm, slightly dry playful humor, never exaggerated), takes a believable small sip of her iced coffee with a warm smile, and delivers her final joke naturally with expressive speaking movements.`,
    `- Chloe responds beside her with a natural warm smile and gentle, genuine laughter, nodding cheerfully.`,
    `- Both characters finish the scene in an upbeat, good mood in the identical café setting.`,
    `SPEAKING RHYTHM CONTEXT (do not display text): ${dialogueSummary}`,
    `CUSTOM SCENE NOTE: ${sceneDescription}`,
    sharedContinuityLock,
  ].join('\n');

  return [
    {
      part: 'main',
      durationTag: '8s',
      durationSec: 8,
      label: 'Close',
      referenceImageAssetPath: mainRefPath,
      hashPrompt,
      prompt: `${hashPrompt}${formatTurnTimingGuidance(turnTimings)}`,
    },
  ];
}

interface InteractionShape {
  id?: string;
  status?: string;
  error?: { message?: string; code?: string } | string | null;
  output_video?: { data?: string | null; uri?: string | null; mime_type?: string | null } | null;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; data?: string; uri?: string }>;
  }>;
}

function hasVideoOutput(interaction: InteractionShape): boolean {
  if (interaction.output_video?.data || interaction.output_video?.uri) {
    return true;
  }
  for (const step of interaction.steps ?? []) {
    if (step.type === 'model_output' && Array.isArray(step.content)) {
      const vid = step.content.find((c) => c.type === 'video' && (c.data || c.uri));
      if (vid) return true;
    }
  }
  return false;
}

function formatInteractionErrorDetail(interaction: InteractionShape): string {
  if (!interaction.error) {
    return `Video generation ended with status "${interaction.status || 'failed'}".`;
  }
  if (typeof interaction.error === 'string') return interaction.error;
  return interaction.error.message || interaction.error.code || JSON.stringify(interaction.error);
}

async function fetchInteractionVideoUri(uri: string): Promise<Buffer> {
  const parsed = new URL(uri);
  const allowedHosts = [
    'generativelanguage.googleapis.com',
    'storage.googleapis.com',
  ];
  const isAllowedHost = allowedHosts.some(
    (h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`)
  );
  if (parsed.protocol !== 'https:' || !isAllowedHost) {
    throw new Error('Rejected unexpected video download host.');
  }

  const resp = await fetch(uri, {
    headers: process.env.GEMINI_API_KEY
      ? { 'x-goog-api-key': process.env.GEMINI_API_KEY }
      : undefined,
  });
  if (!resp.ok) {
    throw new Error(`Failed to download generated video bytes (HTTP ${resp.status}).`);
  }
  const arr = await resp.arrayBuffer();
  const buf = Buffer.from(arr);
  if (buf.length < 4096) {
    throw new Error('Downloaded video file was empty or incomplete.');
  }
  return buf;
}

async function extractVideoBufferFromInteraction(
  interaction: InteractionShape
): Promise<Buffer> {
  if (interaction.output_video?.data) {
    const buf = Buffer.from(interaction.output_video.data, 'base64');
    if (buf.length < 4096) {
      throw new Error('Returned base64 video output was empty or incomplete.');
    }
    return buf;
  }

  for (const step of interaction.steps ?? []) {
    if (step.type === 'model_output' && Array.isArray(step.content)) {
      const vid = step.content.find((c) => c.type === 'video');
      if (vid?.data) {
        const buf = Buffer.from(vid.data, 'base64');
        if (buf.length < 4096) {
          throw new Error('Returned step video output was empty or incomplete.');
        }
        return buf;
      }
      if (vid?.uri) {
        return fetchInteractionVideoUri(vid.uri);
      }
    }
  }

  if (interaction.output_video?.uri) {
    return fetchInteractionVideoUri(interaction.output_video.uri);
  }

  throw new Error('Video generation completed without returning video bytes.');
}

export function getCachedBeatVideoSegments(params: {
  style: VisualStyleId;
  beatId: BeatId;
  scenePlace: string;
  sceneSituation: string;
  sceneDescription: string;
  dialogueLines: Array<{ speaker: string; line: string }>;
}): VideoClipSegment[] | null {
  const specs = buildSubClipSpecs(params);
  const results: VideoClipSegment[] = [];

  for (const spec of specs) {
    const promptHash = computeVideoPromptHash({
      style: params.style,
      beatId: params.beatId,
      part: spec.part,
      prompt: spec.hashPrompt,
      referenceImagePath: spec.referenceImageAssetPath,
      durationTag: spec.durationTag,
    });
    const cached = getCachedVideoClip({
      style: params.style,
      beatId: params.beatId,
      part: spec.part,
      promptHash,
      durationSec: spec.durationSec,
      trimStartSec: spec.trimStartSec,
      trimEndSec: spec.trimEndSec,
      label: spec.label,
    });
    if (!cached) {
      return null;
    }
    results.push({
      url: cached.url,
      durationSec: cached.durationSec,
      trimStartSec: cached.trimStartSec,
      trimEndSec: cached.trimEndSec,
      label: cached.label,
    });
  }

  return results;
}

export function getBeatPendingOperationInfo(params: {
  style: VisualStyleId;
  beatId: BeatId;
  scenePlace: string;
  sceneSituation: string;
  sceneDescription: string;
  dialogueLines: Array<{ speaker: string; line: string }>;
}): { interactionId: string; pendingClipLabel: string } | null {
  const specs = buildSubClipSpecs(params);
  for (const spec of specs) {
    const promptHash = computeVideoPromptHash({
      style: params.style,
      beatId: params.beatId,
      part: spec.part,
      prompt: spec.hashPrompt,
      referenceImagePath: spec.referenceImageAssetPath,
      durationTag: spec.durationTag,
    });
    const op = getPendingVideoOperation({
      style: params.style,
      beatId: params.beatId,
      part: spec.part,
      promptHash,
    });
    if (op) {
      return {
        interactionId: op.interactionId,
        pendingClipLabel: spec.label,
      };
    }
  }
  return null;
}

export interface BeatVideoStepResult {
  status: 'ready' | 'pending';
  segments: VideoClipSegment[];
  pendingClipLabel?: string;
  interactionId?: string;
  completedClips: number;
  totalClips: number;
}

/**
 * Advances moving-video generation for one beat asynchronously (non-blocking).
 * Each HTTP call checks cached MP4s, recovers/polls any persisted interactionId via
 * ai.interactions.get(), or starts at most one background interaction (background: true, store: true).
 */
export async function advanceBeatVideoGeneration(params: {
  ai?: GoogleGenAI;
  style: VisualStyleId;
  beatId: BeatId;
  scenePlace: string;
  sceneSituation: string;
  sceneDescription: string;
  dialogueLines: Array<{ speaker: string; line: string }>;
  turnTimings?: TurnTiming[];
}): Promise<BeatVideoStepResult> {
  const { style, beatId } = params;
  const ai = ensureV1BetaVideoClient(params.ai);
  const specs = buildSubClipSpecs(params);
  const segments: VideoClipSegment[] = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const promptHash = computeVideoPromptHash({
      style,
      beatId,
      part: spec.part,
      prompt: spec.hashPrompt,
      referenceImagePath: spec.referenceImageAssetPath,
      durationTag: spec.durationTag,
    });

    const cached = getCachedVideoClip({
      style,
      beatId,
      part: spec.part,
      promptHash,
      durationSec: spec.durationSec,
      trimStartSec: spec.trimStartSec,
      trimEndSec: spec.trimEndSec,
      label: spec.label,
    });

    if (cached) {
      segments.push({
        url: cached.url,
        durationSec: cached.durationSec,
        trimStartSec: cached.trimStartSec,
        trimEndSec: cached.trimEndSec,
        label: cached.label,
      });
      continue;
    }

    const pendingOp = getPendingVideoOperation({
      style,
      beatId,
      part: spec.part,
      promptHash,
    });

    if (pendingOp) {
      let polled: InteractionShape;
      try {
        polled = (await ai.interactions.get(
          pendingOp.interactionId
        )) as unknown as InteractionShape;
      } catch (pollErr: unknown) {
        const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        if (msg.includes('404') || msg.toLowerCase().includes('not_found')) {
          clearPendingVideoOperation({ style, beatId, part: spec.part, promptHash });
          throw new Error(
            `Previous background video operation (${pendingOp.interactionId}) expired before completion. Please retry this scene.`
          );
        }
        throw pollErr;
      }

      if (polled.status === 'failed' || polled.status === 'cancelled') {
        clearPendingVideoOperation({ style, beatId, part: spec.part, promptHash });
        throw new Error(formatInteractionErrorDetail(polled));
      }

      if (hasVideoOutput(polled) || polled.status === 'completed') {
        const videoBuffer = await extractVideoBufferFromInteraction(polled);
        const saved = saveCachedVideoClip({
          style,
          beatId,
          part: spec.part,
          promptHash,
          videoBuffer,
          durationSec: spec.durationSec,
          trimStartSec: spec.trimStartSec,
          trimEndSec: spec.trimEndSec,
          label: spec.label,
        });
        clearPendingVideoOperation({ style, beatId, part: spec.part, promptHash });
        segments.push({
          url: saved.url,
          durationSec: saved.durationSec,
          trimStartSec: saved.trimStartSec,
          trimEndSec: saved.trimEndSec,
          label: saved.label,
        });
        continue;
      }

      const ageMs = Date.now() - Date.parse(pendingOp.createdAt);
      if (Number.isFinite(ageMs) && ageMs > 15 * 60 * 1000) {
        clearPendingVideoOperation({ style, beatId, part: spec.part, promptHash });
        throw new Error(
          `Video generation for ${spec.label} did not finish within 15 minutes.`
        );
      }

      return {
        status: 'pending',
        segments,
        pendingClipLabel: spec.label,
        interactionId: pendingOp.interactionId,
        completedClips: segments.length,
        totalClips: specs.length,
      };
    }

    // Start a new background interaction (store: true required for background: true)
    const refImage = loadAssetImageBase64(spec.referenceImageAssetPath);
    const created = (await ai.interactions.create(
      {
        model: 'gemini-omni-1.2-flash',
        input: [
          {
            type: 'image',
            mime_type: refImage.mimeType,
            data: refImage.base64,
          },
          {
            type: 'text',
            text: spec.prompt,
          },
        ],
        background: true,
        store: true,
        stream: false,
        response_format: {
          type: 'video',
          aspect_ratio: '16:9',
          duration: spec.durationTag,
          resolution: '720p',
        },
      },
      { timeout: 30000 }
    )) as unknown as InteractionShape;

    if (created.status === 'failed' || created.status === 'cancelled') {
      throw new Error(formatInteractionErrorDetail(created));
    }

    if (hasVideoOutput(created) || created.status === 'completed') {
      const videoBuffer = await extractVideoBufferFromInteraction(created);
      const saved = saveCachedVideoClip({
        style,
        beatId,
        part: spec.part,
        promptHash,
        videoBuffer,
        durationSec: spec.durationSec,
        trimStartSec: spec.trimStartSec,
        trimEndSec: spec.trimEndSec,
        label: spec.label,
      });
      segments.push({
        url: saved.url,
        durationSec: saved.durationSec,
        trimStartSec: saved.trimStartSec,
        trimEndSec: saved.trimEndSec,
        label: saved.label,
      });
      continue;
    }

    if (!created.id) {
      throw new Error('Video generation API did not return a background operation ID.');
    }

    savePendingVideoOperation({
      interactionId: created.id,
      beatId,
      style,
      part: spec.part,
      promptHash,
      durationSec: spec.durationSec,
      trimStartSec: spec.trimStartSec,
      trimEndSec: spec.trimEndSec,
      label: spec.label,
    });

    return {
      status: 'pending',
      segments,
      pendingClipLabel: spec.label,
      interactionId: created.id,
      completedClips: segments.length,
      totalClips: specs.length,
    };
  }

  return {
    status: 'ready',
    segments,
    completedClips: segments.length,
    totalClips: specs.length,
  };
}

