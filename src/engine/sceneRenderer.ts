import {
  BeatId,
  BeatSceneDirection,
  StoryboardData,
  SubtitleCue,
  VisualStyleId,
} from '../types';

export interface RenderFrameParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  style: VisualStyleId;
  storyboard: StoryboardData;
  direction: BeatSceneDirection;
  beatId?: string;
  beatElapsedSec: number;
  beatDurationSec: number;
  activeSpeaker: string | null;
  isPlayingAudio: boolean;
  activeVideoElement?: HTMLVideoElement | null;
  lastCueEndSec?: number;
  subtitleText?: string;
  renderSubtitlesOnCanvas?: boolean;
}

const BEAT_IMAGE_MAP: Record<VisualStyleId, Record<BeatId, string>> = {
  live_action: {
    hook: '/src/assets/images/live_hook_v4_1795683336850.jpg',
    problem: '/src/assets/images/live_problem_v5_1795683967023.jpg',
    turn: '/src/assets/images/live_turn_v4_1795683342615.jpg',
    close: '/src/assets/images/live_close_v3_1795681900444.jpg',
  },
  '3d_animation': {
    hook: '/src/assets/images/anim3d_hook_v3_1795681837924.jpg',
    problem: '/src/assets/images/anim3d_problem_v4_1795683339749.jpg',
    turn: '/src/assets/images/anim3d_turn_v4_1795683344365.jpg',
    close: '/src/assets/images/anim3d_close_v3_1795681906134.jpg',
  },
  '2d_animation': {
    hook: '/src/assets/images/anim2d_hook_v3_1795681839874.jpg',
    problem: '/src/assets/images/anim2d_problem_v5_1795683340859.jpg',
    turn: '/src/assets/images/anim2d_turn_v5_1795683345432.jpg',
    close: '/src/assets/images/anim2d_close_v4_1795681926578.jpg',
  },
  american_comic: {
    hook: '/src/assets/images/comic_hook_v3_1795681839482.jpg',
    problem: '/src/assets/images/comic_problem_v4_1795683341997.jpg',
    turn: '/src/assets/images/comic_turn_v6_1795683345812.jpg',
    close: '/src/assets/images/comic_close_v3_1795681917984.jpg',
  },
};

const PROBLEM_INSERT_IMAGE_MAP: Record<VisualStyleId, string> = {
  live_action: '/src/assets/images/live_problem_insert_v2_1795683967234.jpg',
  '3d_animation': '/src/assets/images/anim3d_problem_insert_v2_1795679558526.jpg',
  '2d_animation': '/src/assets/images/anim2d_problem_insert_v3_1795681904400.jpg',
  american_comic: '/src/assets/images/comic_problem_insert_v2_1795679610406.jpg',
};

const PROBLEM_INSERT_DURATION_SEC = 1.75;

const imageCache = new Map<string, HTMLImageElement>();

function resolveBeatId(raw?: string): BeatId {
  if (raw === 'hook' || raw === 'problem' || raw === 'turn' || raw === 'close') {
    return raw;
  }
  return 'hook';
}

export function getBeatImageUrl(style: VisualStyleId, beatId?: string): string {
  const styleSet = BEAT_IMAGE_MAP[style];
  if (!styleSet) {
    throw new Error(`Unsupported visual style: ${String(style)}`);
  }
  return styleSet[resolveBeatId(beatId)];
}

export function getProblemInsertImageUrl(style: VisualStyleId): string {
  const url = PROBLEM_INSERT_IMAGE_MAP[style];
  if (!url) {
    throw new Error(`Unsupported visual style: ${String(style)}`);
  }
  return url;
}

export async function ensureSubtitleFontsLoaded(): Promise<void> {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    try {
      await Promise.all([
        document.fonts.load('600 32px "Inter"'),
        document.fonts.load('600 24px "Inter"'),
      ]);
      await document.fonts.ready;
    } catch {
      // System sans fallback (Arial) remains ready immediately
    }
  }
}

export async function preloadStyleAssets(style?: VisualStyleId): Promise<void[]> {
  const urls = style
    ? [...Object.values(BEAT_IMAGE_MAP[style]), PROBLEM_INSERT_IMAGE_MAP[style]]
    : [
        ...Object.values(BEAT_IMAGE_MAP).flatMap((group) => Object.values(group)),
        ...Object.values(PROBLEM_INSERT_IMAGE_MAP),
      ];

  await ensureSubtitleFontsLoaded();

  const promises = urls.map(
    (url) =>
      new Promise<void>((resolve) => {
        const existing = imageCache.get(url);
        if (existing && existing.complete && existing.naturalWidth > 0) {
          resolve();
          return;
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          imageCache.set(url, img);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = url;
        imageCache.set(url, img);
      })
  );

  return Promise.all(promises);
}

function getLoadedImage(url: string): HTMLImageElement | null {
  let img = imageCache.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    imageCache.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

function easeInOut(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
}

function drawAspectCoverImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  scale: number,
  panX: number,
  panY: number
) {
  ctx.save();
  ctx.translate(w / 2 + panX, h / 2 + panY);
  ctx.scale(scale, scale);

  const imgAspect = img.naturalWidth / img.naturalHeight;
  const canvasAspect = w / h;
  let drawW = w;
  let drawH = h;
  if (imgAspect > canvasAspect) {
    drawW = h * imgAspect;
  } else {
    drawH = w / imgAspect;
  }

  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
}

function drawAspectCoverVideo(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number
) {
  const vw = video.videoWidth || w;
  const vh = video.videoHeight || h;
  const vidAspect = vw / vh;
  const canvasAspect = w / h;
  let drawW = w;
  let drawH = h;
  if (vidAspect > canvasAspect) {
    drawW = h * vidAspect;
  } else {
    drawH = w / vidAspect;
  }
  ctx.drawImage(video, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
}

function renderArtworkWithCameraMotion(params: RenderFrameParams) {
  const {
    ctx,
    width: w,
    height: h,
    style,
    direction,
    beatId,
    beatElapsedSec,
    beatDurationSec,
    activeVideoElement,
    lastCueEndSec,
  } = params;

  const safeDurationSec = Math.max(0.5, beatDurationSec);
  const progress = clamp01(beatElapsedSec / safeDurationSec);
  const resolvedBeatId = resolveBeatId(beatId);

  if (
    activeVideoElement &&
    activeVideoElement.readyState >= 2 &&
    activeVideoElement.videoWidth > 0
  ) {
    ctx.save();
    ctx.fillStyle = '#141112';
    ctx.fillRect(0, 0, w, h);
    drawAspectCoverVideo(ctx, activeVideoElement, w, h);

    if (beatElapsedSec < 0.12) {
      const introFade = 1 - clamp01(beatElapsedSec / 0.12);
      ctx.fillStyle = `rgba(10, 10, 12, ${introFade * 0.35})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (direction.cutToBlackAtEnd || resolvedBeatId === 'close') {
      const fadeStartSec = Math.max(
        (lastCueEndSec ?? safeDurationSec - 1.15) + 0.36,
        safeDurationSec - 0.97
      );
      if (beatElapsedSec >= fadeStartSec) {
        const fade = clamp01((beatElapsedSec - fadeStartSec) / 0.26);
        ctx.fillStyle = `rgba(10, 10, 12, ${fade})`;
        ctx.fillRect(0, 0, w, h);

        if (beatElapsedSec >= fadeStartSec + 0.2) {
          const creditAlpha = clamp01((beatElapsedSec - (fadeStartSec + 0.2)) / 0.2);
          const scale = h / 1080;
          const creditFontSize = Math.max(16, Math.round(33 * scale));
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
          ctx.font = `600 ${creditFontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = `rgba(245, 240, 230, ${creditAlpha})`;
          ctx.fillText('Made with Google AI Studio · Script by [Noel Roh]', w / 2, h / 2);
          ctx.restore();
        }
      }
    }

    ctx.restore();
    return;
  }

  // Beat 2 (Problem): Shot A = brief 1.5-2s close-up laptop insert of cat birthday slideshow,
  // followed by a quick cut to Shot B = return two-shot reaction.
  const problemInsertCutoffSec = Math.min(2.0, PROBLEM_INSERT_DURATION_SEC, safeDurationSec * 0.4);
  const problemInsertCutRatio = clamp01(problemInsertCutoffSec / safeDurationSec);

  const isProblemInsertShot =
    resolvedBeatId === 'problem' && progress < problemInsertCutRatio;
  const isProblemReturnShot =
    resolvedBeatId === 'problem' && progress >= problemInsertCutRatio;

  const subProgress = isProblemInsertShot
    ? clamp01(progress / Math.max(0.01, problemInsertCutRatio))
    : isProblemReturnShot
    ? clamp01((progress - problemInsertCutRatio) / Math.max(0.01, 1 - problemInsertCutRatio))
    : progress;

  const eased = easeInOut(subProgress);
  const url = isProblemInsertShot
    ? getProblemInsertImageUrl(style)
    : getBeatImageUrl(style, resolvedBeatId);
  const img = getLoadedImage(url);

  // Subtle camera motion tailored to each visual style (no overlays, no stickers, no fake boxes)
  let baseStartScale = direction.kenBurns?.startScale ?? 1.01;
  let baseEndScale = direction.kenBurns?.endScale ?? 1.07;
  let panX0 = direction.kenBurns?.startX ?? -8;
  let panX1 = direction.kenBurns?.endX ?? 8;
  let panY0 = direction.kenBurns?.startY ?? 0;
  let panY1 = direction.kenBurns?.endY ?? 0;

  if (isProblemInsertShot) {
    baseStartScale = 1.0;
    baseEndScale = 1.045;
    panX0 = 0;
    panX1 = 0;
    panY0 = 2;
    panY1 = -2;
  } else if (style === 'american_comic') {
    // Motion-comic sequential framing drift across the frame
    baseStartScale = 1.01;
    baseEndScale = 1.055;
    panX0 = 8;
    panX1 = -8;
    panY0 = -2;
    panY1 = 2;
  } else if (style === '2d_animation') {
    // Clean, simple, readable sitcom framing
    baseStartScale = 1.0;
    baseEndScale = 1.04;
    panX0 = -5;
    panX1 = 5;
    panY0 = 0;
    panY1 = 0;
  } else if (style === 'live_action') {
    // Crisp sitcom framing with light clean pan and minimal zoom (no dreamy slow motion)
    baseStartScale = 1.0;
    baseEndScale = 1.03;
    panX0 = -4;
    panX1 = 4;
    panY0 = 0;
    panY1 = 0;
  }

  const scale = lerp(baseStartScale, baseEndScale, eased);
  const panX = lerp(panX0, panX1, eased);
  const panY = lerp(panY0, panY1, eased);

  ctx.save();
  ctx.fillStyle = '#141112';
  ctx.fillRect(0, 0, w, h);

  if (img) {
    drawAspectCoverImage(ctx, img, w, h, scale, panX, panY);
  }

  // Subtle natural edge depth for 3D only (keep live_action bright, even, high-key studio lit)
  if (style === '3d_animation') {
    const vig = ctx.createRadialGradient(
      w / 2,
      h / 2,
      w * 0.32,
      w / 2,
      h / 2,
      w * 0.78
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(10, 8, 8, 0.24)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }

  // Brief clean transition at start of each beat (140ms local fade-in)
  if (beatElapsedSec < 0.14) {
    const introFade = 1 - clamp01(beatElapsedSec / 0.14);
    ctx.fillStyle = `rgba(10, 10, 12, ${introFade * 0.45})`;
    ctx.fillRect(0, 0, w, h);
  }

  // Approved storyboard Close beat ends with "Cut to black." and clean original end credit
  if (direction.cutToBlackAtEnd || resolvedBeatId === 'close') {
    const fadeStartSec = Math.max(
      (lastCueEndSec ?? safeDurationSec - 1.15) + 0.18,
      safeDurationSec - 1.15
    );
    if (beatElapsedSec >= fadeStartSec) {
      const fade = clamp01((beatElapsedSec - fadeStartSec) / 0.28);
      ctx.fillStyle = `rgba(10, 10, 12, ${fade})`;
      ctx.fillRect(0, 0, w, h);

      if (beatElapsedSec >= fadeStartSec + 0.22) {
        const creditAlpha = clamp01((beatElapsedSec - (fadeStartSec + 0.22)) / 0.22);
        const scale = h / 1080;
        const creditFontSize = Math.max(16, Math.round(33 * scale));
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.font = `600 ${creditFontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(245, 240, 230, ${creditAlpha})`;
        ctx.fillText('Made with Google AI Studio · Script by [Noel Roh]', w / 2, h / 2);
        ctx.restore();
      }
    }
  }

  ctx.restore();
}

function wrapSubtitleIntoMaxTwoLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (ctx.measureText(clean).width <= maxWidth) {
    return [clean];
  }

  const words = clean.split(' ').filter(Boolean);
  if (words.length <= 1) return [clean];

  // Pick the cleanest balanced two-line split without ever dropping or truncating words
  let bestSplit = Math.ceil(words.length / 2);
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const line1 = words.slice(0, i).join(' ');
    const line2 = words.slice(i).join(' ');
    const w1 = ctx.measureText(line1).width;
    const w2 = ctx.measureText(line2).width;
    const overflowPenalty = (w1 > maxWidth ? w1 - maxWidth : 0) + (w2 > maxWidth ? w2 - maxWidth : 0);
    const balanceScore = Math.abs(w1 - w2) + overflowPenalty * 4;
    if (balanceScore < bestDiff) {
      bestDiff = balanceScore;
      bestSplit = i;
    }
  }

  return [
    words.slice(0, bestSplit).join(' '),
    words.slice(bestSplit).join(' '),
  ];
}

export function drawSubtitlesOnCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  text: string
) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return;

  const resScale = h / 1080;
  const fontSize = Math.max(20, Math.round(46 * resScale));
  const lineHeight = Math.round(fontSize * 1.28);
  const bottomSafeMargin = Math.round(54 * resScale);
  // Subtle ~1px outline target at 1080p (proportional across resolutions, painted before fill)
  const strokeWidth = Math.max(0.85, Number((1.15 * resScale).toFixed(2)));

  ctx.save();
  // Explicitly reset text drawing state to eliminate shadow smears or miter artifacts
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.font = `700 ${fontSize}px "Inter", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  const maxWidth = w * 0.84;
  const finalLines = wrapSubtitleIntoMaxTwoLines(ctx, clean, maxWidth).slice(0, 2);
  const baseY = h - bottomSafeMargin;

  finalLines.forEach((line, idx) => {
    const y = baseY - (finalLines.length - 1 - idx) * lineHeight;
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.strokeText(line, w / 2, y);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(line, w / 2, y);
  });

  ctx.restore();
}

export function renderBeatFrame(params: RenderFrameParams) {
  const { style, ctx, width, height, renderSubtitlesOnCanvas, subtitleText } = params;

  if (
    style !== 'live_action' &&
    style !== '3d_animation' &&
    style !== '2d_animation' &&
    style !== 'american_comic'
  ) {
    throw new Error(`Unsupported visual style: ${String(style)}`);
  }

  renderArtworkWithCameraMotion(params);

  // Identical Canvas subtitle layer for both preview player and video export
  if (renderSubtitlesOnCanvas && subtitleText) {
    drawSubtitlesOnCanvas(ctx, width, height, subtitleText);
  }
}

export function getActiveSubtitleCue(
  cues: SubtitleCue[],
  beatElapsedSec: number
): SubtitleCue | null {
  for (const cue of cues) {
    if (beatElapsedSec >= cue.startSec && beatElapsedSec <= cue.endSec) {
      return cue;
    }
  }
  return null;
}
