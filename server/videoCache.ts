import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface CachedVideoClipRecord {
  beatId: string;
  style: string;
  part: string;
  filename: string;
  url: string;
  durationSec: number;
  trimStartSec?: number;
  trimEndSec?: number;
  label?: string;
  createdAt: string;
}

const VIDEO_CACHE_ROOT = path.resolve('server/cache/videos');

const ALLOWED_STYLES = new Set([
  'live_action',
  '3d_animation',
  '2d_animation',
  'american_comic',
]);

export function sanitizeStyleDir(style: string): string {
  if (!ALLOWED_STYLES.has(style)) {
    throw new Error(`Invalid visual style: ${style}`);
  }
  return style;
}

export function getVideoFilePath(style: string, filename: string): string | null {
  if (!ALLOWED_STYLES.has(style)) return null;
  if (!/^[a-z0-9_-]+\.mp4$/i.test(filename)) return null;

  const styleDir = path.resolve(VIDEO_CACHE_ROOT, style);
  const resolved = path.resolve(styleDir, filename);
  if (!resolved.startsWith(styleDir + path.sep)) {
    return null;
  }
  return resolved;
}

export function computeVideoPromptHash(input: {
  style: string;
  beatId: string;
  part: string;
  prompt: string;
  referenceImagePath: string;
  durationTag: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    style: input.style,
    beatId: input.beatId,
    part: input.part,
    prompt: input.prompt.trim(),
    referenceImagePath: input.referenceImagePath,
    durationTag: input.durationTag,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function getCachedVideoClip(params: {
  style: string;
  beatId: string;
  part: string;
  promptHash: string;
  durationSec: number;
  trimStartSec?: number;
  trimEndSec?: number;
  label?: string;
}): CachedVideoClipRecord | null {
  try {
    const safeStyle = sanitizeStyleDir(params.style);
    const filename = `${params.beatId}_${params.part}_${params.promptHash}.mp4`;
    const filePath = getVideoFilePath(safeStyle, filename);
    if (!filePath || !fs.existsSync(filePath)) return null;

    const stat = fs.statSync(filePath);
    if (stat.size < 4096) return null;

    return {
      beatId: params.beatId,
      style: safeStyle,
      part: params.part,
      filename,
      url: `/api/video/clip/${safeStyle}/${filename}`,
      durationSec: params.durationSec,
      trimStartSec: params.trimStartSec,
      trimEndSec: params.trimEndSec,
      label: params.label,
      createdAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveCachedVideoClip(params: {
  style: string;
  beatId: string;
  part: string;
  promptHash: string;
  videoBuffer: Buffer;
  durationSec: number;
  trimStartSec?: number;
  trimEndSec?: number;
  label?: string;
}): CachedVideoClipRecord {
  const safeStyle = sanitizeStyleDir(params.style);
  const styleDir = path.resolve(VIDEO_CACHE_ROOT, safeStyle);
  fs.mkdirSync(styleDir, { recursive: true });

  const filename = `${params.beatId}_${params.part}_${params.promptHash}.mp4`;
  const filePath = getVideoFilePath(safeStyle, filename);
  if (!filePath) {
    throw new Error('Invalid cache path for generated video.');
  }

  fs.writeFileSync(filePath, params.videoBuffer);

  return {
    beatId: params.beatId,
    style: safeStyle,
    part: params.part,
    filename,
    url: `/api/video/clip/${safeStyle}/${filename}`,
    durationSec: params.durationSec,
    trimStartSec: params.trimStartSec,
    trimEndSec: params.trimEndSec,
    label: params.label,
    createdAt: new Date().toISOString(),
  };
}

export interface PendingVideoOperationRecord {
  interactionId: string;
  beatId: string;
  style: string;
  part: string;
  promptHash: string;
  durationSec: number;
  trimStartSec?: number;
  trimEndSec?: number;
  label?: string;
  createdAt: string;
}

const VIDEO_OPS_ROOT = path.resolve('server/cache/operations');

function getPendingOpFilePath(style: string, filename: string): string | null {
  if (!ALLOWED_STYLES.has(style)) return null;
  if (!/^[a-z0-9_-]+\.json$/i.test(filename)) return null;

  const styleDir = path.resolve(VIDEO_OPS_ROOT, style);
  const resolved = path.resolve(styleDir, filename);
  if (!resolved.startsWith(styleDir + path.sep)) {
    return null;
  }
  return resolved;
}

export function getPendingVideoOperation(params: {
  style: string;
  beatId: string;
  part: string;
  promptHash: string;
}): PendingVideoOperationRecord | null {
  try {
    const safeStyle = sanitizeStyleDir(params.style);
    const filename = `${params.beatId}_${params.part}_${params.promptHash}.json`;
    const filePath = getPendingOpFilePath(safeStyle, filename);
    if (!filePath || !fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as PendingVideoOperationRecord;
    if (parsed && typeof parsed.interactionId === 'string' && parsed.interactionId.length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function savePendingVideoOperation(
  record: Omit<PendingVideoOperationRecord, 'createdAt'>
): PendingVideoOperationRecord {
  const safeStyle = sanitizeStyleDir(record.style);
  const styleDir = path.resolve(VIDEO_OPS_ROOT, safeStyle);
  fs.mkdirSync(styleDir, { recursive: true });

  const filename = `${record.beatId}_${record.part}_${record.promptHash}.json`;
  const filePath = getPendingOpFilePath(safeStyle, filename);
  if (!filePath) {
    throw new Error('Invalid cache path for pending video operation.');
  }

  const full: PendingVideoOperationRecord = {
    ...record,
    style: safeStyle,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(full));
  return full;
}

export function clearPendingVideoOperation(params: {
  style: string;
  beatId: string;
  part: string;
  promptHash: string;
}): void {
  try {
    const safeStyle = sanitizeStyleDir(params.style);
    const filename = `${params.beatId}_${params.part}_${params.promptHash}.json`;
    const filePath = getPendingOpFilePath(safeStyle, filename);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Non-fatal cleanup
  }
}

