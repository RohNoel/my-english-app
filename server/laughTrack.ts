import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

export interface ParsedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcmData: Buffer;
  durationSec: number;
}

const LAUGH_ASSET_PATH = path.resolve('src/assets/audio/sitcom_audience_laugh.wav');
let cachedStudioLaughPcm: Buffer | null = null;
const STUDIO_SAMPLE_RATE = 24000;

export function createAudioAiClient(): GoogleGenAI {
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

function ensureV1BetaAudioClient(ai?: GoogleGenAI): GoogleGenAI {
  const currentVersion = (
    ai as unknown as { apiClient?: { getApiVersion?: () => string } } | undefined
  )?.apiClient?.getApiVersion?.();
  if (ai && currentVersion === 'v1beta') {
    return ai;
  }
  return createAudioAiClient();
}

export function parseWavBuffer(wavBuffer: Buffer): ParsedWav {
  if (wavBuffer.length < 44) {
    return {
      sampleRate: STUDIO_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      pcmData: Buffer.alloc(0),
      durationSec: 2,
    };
  }

  const channels = wavBuffer.readUInt16LE(22) || 1;
  const sampleRate = wavBuffer.readUInt32LE(24) || STUDIO_SAMPLE_RATE;
  const bitsPerSample = wavBuffer.readUInt16LE(34) || 16;

  let offset = 12;
  let pcmData = wavBuffer.subarray(44);
  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const start = offset + 8;
      const end = Math.min(wavBuffer.length, start + chunkSize);
      pcmData = wavBuffer.subarray(start, end);
      break;
    }
    offset += 8 + chunkSize;
  }

  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const durationSec = byteRate > 0 ? pcmData.length / byteRate : 2;
  return { sampleRate, channels, bitsPerSample, pcmData, durationSec };
}

export function buildWavFromPcm(
  pcmChunks: Buffer[],
  sampleRate = STUDIO_SAMPLE_RATE,
  channels = 1,
  bitsPerSample = 16
): Buffer {
  const totalPcmBytes = pcmChunks.reduce((s, b) => s + b.length, 0);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + totalPcmBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(totalPcmBytes, 40);

  return Buffer.concat([header, ...pcmChunks]);
}

function pcmToFloat32(pcm: Buffer): Float32Array {
  const count = Math.floor(pcm.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

function float32ToPcm(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-0.98, Math.min(0.98, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return out;
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / samples.length);
}

function trimActiveWindow(samples: Float32Array, sampleRate: number): Float32Array {
  const thresh = 0.012;
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < thresh) {
    start++;
  }
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < thresh) {
    end--;
  }
  start = Math.max(0, start - Math.round(sampleRate * 0.04));
  end = Math.min(samples.length, end + Math.round(sampleRate * 0.08));
  return samples.subarray(start, end);
}

function resampleLinear(input: Float32Array, rateRatio: number): Float32Array {
  if (input.length === 0) return input;
  const outLen = Math.max(1, Math.floor(input.length / rateRatio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * rateRatio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[Math.min(idx, input.length - 1)];
    const s1 = input[Math.min(idx + 1, input.length - 1)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

async function generateSingleVoiceLaugh(
  ai: GoogleGenAI,
  voiceName: 'Puck' | 'Kore',
  styleHint: string
): Promise<Float32Array> {
  const resp = await ai.models.generateContent({
    model: 'gemini-3.8-flash-tts',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: '<laugh>',
            speechMetadata: {
              style: styleHint,
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const b64 = resp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? '';
  if (!b64) {
    throw new Error('Failed to generate studio audience laugh audio.');
  }
  const parsed = parseWavBuffer(Buffer.from(b64, 'base64'));
  return trimActiveWindow(pcmToFloat32(parsed.pcmData), parsed.sampleRate);
}

export async function getOrCreateStudioLaughTrack(ai?: GoogleGenAI): Promise<Buffer> {
  if (cachedStudioLaughPcm && cachedStudioLaughPcm.length > 0) {
    return cachedStudioLaughPcm;
  }

  if (fs.existsSync(LAUGH_ASSET_PATH)) {
    const raw = fs.readFileSync(LAUGH_ASSET_PATH);
    const parsed = parseWavBuffer(raw);
    if (parsed.pcmData.length > 0) {
      cachedStudioLaughPcm = parsed.pcmData;
      return cachedStudioLaughPcm;
    }
  }

  const audioAi = ensureV1BetaAudioClient(ai);

  const srcA = await generateSingleVoiceLaugh(
    audioAi,
    'Puck',
    'Warm, relaxed studio audience chuckle, natural and brief, no speech'
  );
  let srcB = srcA;
  try {
    srcB = await generateSingleVoiceLaugh(
      audioAi,
      'Kore',
      'Light, genuine amused studio audience chuckle, quiet sitcom crowd, no words'
    );
  } catch {
    // Gracefully layer srcA with varied pitch/time offsets if secondary call is rate-limited
    srcB = srcA;
  }

  // Mix and stagger 6 vocal layers (with slight natural pitch/speed variation) into 1.45s studio audience texture
  const targetLen = Math.round(STUDIO_SAMPLE_RATE * 1.45);
  const dryMix = new Float32Array(targetLen);

  const layers: Array<{ src: Float32Array; delaySec: number; ratio: number; gain: number }> = [
    { src: srcA, delaySec: 0.0, ratio: 1.0, gain: 0.34 },
    { src: srcB, delaySec: 0.05, ratio: 1.02, gain: 0.36 },
    { src: srcA, delaySec: 0.11, ratio: 0.94, gain: 0.30 },
    { src: srcB, delaySec: 0.16, ratio: 1.07, gain: 0.28 },
    { src: srcA, delaySec: 0.23, ratio: 0.89, gain: 0.24 },
    { src: srcB, delaySec: 0.29, ratio: 1.12, gain: 0.22 },
  ];

  for (const layer of layers) {
    const resampled = resampleLinear(layer.src, layer.ratio);
    const offsetSamples = Math.round(layer.delaySec * STUDIO_SAMPLE_RATE);
    for (let i = 0; i < resampled.length; i++) {
      const destIdx = offsetSamples + i;
      if (destIdx >= targetLen) break;
      dryMix[destIdx] += resampled[i] * layer.gain;
    }
  }

  // Add subtle studio room acoustics (gentle early reflections + warm high-frequency smoothing)
  const roomMix = new Float32Array(targetLen);
  const tap1 = Math.round(STUDIO_SAMPLE_RATE * 0.019);
  const tap2 = Math.round(STUDIO_SAMPLE_RATE * 0.041);
  const tap3 = Math.round(STUDIO_SAMPLE_RATE * 0.073);

  let prev = 0;
  for (let i = 0; i < targetLen; i++) {
    const direct = dryMix[i];
    const r1 = i >= tap1 ? dryMix[i - tap1] * 0.26 : 0;
    const r2 = i >= tap2 ? dryMix[i - tap2] * 0.18 : 0;
    const r3 = i >= tap3 ? dryMix[i - tap3] * 0.11 : 0;
    const raw = direct * 0.78 + r1 + r2 + r3;
    // Gentle single-pole low-pass for warm studio room tone
    const warm = prev * 0.28 + raw * 0.72;
    prev = warm;
    roomMix[i] = warm;
  }

  // Smooth fade-in (110ms) and smooth fade-out (420ms)
  const fadeInSamples = Math.round(STUDIO_SAMPLE_RATE * 0.11);
  const fadeOutSamples = Math.round(STUDIO_SAMPLE_RATE * 0.42);
  for (let i = 0; i < targetLen; i++) {
    let env = 1;
    if (i < fadeInSamples) {
      env *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeInSamples);
    }
    if (i >= targetLen - fadeOutSamples) {
      const rem = targetLen - 1 - i;
      env *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, rem)) / fadeOutSamples);
    }
    roomMix[i] *= env;
  }

  // Normalize master studio laugh asset to clean reference level (RMS ~0.12)
  const currentRms = computeRms(roomMix) || 0.01;
  const normScale = Math.min(2.5, 0.12 / currentRms);
  for (let i = 0; i < targetLen; i++) {
    roomMix[i] = Math.tanh(roomMix[i] * normScale * 0.85);
  }

  const pcmOut = float32ToPcm(roomMix);
  fs.mkdirSync(path.dirname(LAUGH_ASSET_PATH), { recursive: true });
  fs.writeFileSync(
    LAUGH_ASSET_PATH,
    buildWavFromPcm([pcmOut], STUDIO_SAMPLE_RATE, 1, 16)
  );
  cachedStudioLaughPcm = pcmOut;
  return pcmOut;
}

export function mixStudioLaughAfterDialogue(params: {
  dialoguePcm: Buffer;
  laughPcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  targetBeatDurationSec: number;
}): {
  combinedPcm: Buffer;
  totalDurationSec: number;
  laughDurationSec: number;
} {
  const {
    dialoguePcm,
    laughPcm,
    sampleRate,
    channels,
    bitsPerSample,
    targetBeatDurationSec,
  } = params;

  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dialogueDurationSec = byteRate > 0 ? dialoguePcm.length / byteRate : 6;
  const gapSec = 0.12;

  // Target 1.0–1.45s of audience laughter, shortened if dialogue runs close to beat end so total video stays ~30s
  const headroomSec = Math.max(0.65, targetBeatDurationSec - dialogueDurationSec - gapSec - 0.18);
  const laughDurationSec = Math.min(1.4, headroomSec);

  const laughSamplesAll = pcmToFloat32(laughPcm);
  const desiredLaughSamples = Math.min(
    laughSamplesAll.length,
    Math.max(Math.round(sampleRate * 0.55), Math.round(sampleRate * laughDurationSec))
  );
  const laughSlice = new Float32Array(laughSamplesAll.subarray(0, desiredLaughSamples));

  // Match laugh volume moderately lower than Emma's voice (~0.26 of dialogue RMS)
  const dialogueSamples = pcmToFloat32(dialoguePcm);
  const dialogueRms = Math.max(0.03, computeRms(dialogueSamples));
  const laughRms = Math.max(0.01, computeRms(laughSlice));
  const targetLaughRms = dialogueRms * 0.26;
  const gain = Math.min(0.65, targetLaughRms / laughRms);

  // Smooth fade-in (80ms) and smooth natural fade-out over the last 45% before Beat 3 begins
  const fadeIn = Math.round(sampleRate * 0.08);
  const fadeOut = Math.round(desiredLaughSamples * 0.45);
  for (let i = 0; i < desiredLaughSamples; i++) {
    let env = 1;
    if (i < fadeIn) {
      env *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    }
    if (i >= desiredLaughSamples - fadeOut) {
      const rem = desiredLaughSamples - 1 - i;
      env *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, rem)) / fadeOut);
    }
    laughSlice[i] = laughSlice[i] * gain * env;
  }

  const pauseBytes = Math.round(sampleRate * gapSec) * channels * (bitsPerSample / 8);
  const pauseBuf = Buffer.alloc(pauseBytes);
  const finalLaughPcm = float32ToPcm(laughSlice);
  const combinedPcm = Buffer.concat([dialoguePcm, pauseBuf, finalLaughPcm]);
  const totalDurationSec = byteRate > 0 ? combinedPcm.length / byteRate : dialogueDurationSec + laughDurationSec;

  return {
    combinedPcm,
    totalDurationSec: Number(totalDurationSec.toFixed(2)),
    laughDurationSec: Number((desiredLaughSamples / sampleRate).toFixed(2)),
  };
}
