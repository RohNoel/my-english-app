import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clapperboard,
  Film,
  Loader2,
  PlaySquare,
  RefreshCw,
  Upload,
  Video,
} from 'lucide-react';
import { GeneratedBeatMedia, SceneSetup, StoryboardData } from '../types';
import { VISUAL_STYLE_OPTIONS } from '../data/courseExpressions';
import { formatRetryDurationHuman } from '../utils/subtitleUtils';

interface VideoGenStepProps {
  storyboard: StoryboardData;
  scene: SceneSetup;
  beatMedia: Record<string, GeneratedBeatMedia>;
  isGeneratingAll: boolean;
  isPreparingFallback?: boolean;
  isImportingMaster?: boolean;
  importMasterError?: string | null;
  onGenerateAll: () => void;
  onRetryBeat: (beatId: string) => void;
  onImportMasterVideo?: (file: File) => void;
  onBack: () => void;
  onWatchFinal: () => void;
  onWatchSlideshowFallback: () => void;
}

export const VideoGenStep: React.FC<VideoGenStepProps> = ({
  storyboard,
  scene,
  beatMedia,
  isGeneratingAll,
  isPreparingFallback = false,
  isImportingMaster = false,
  importMasterError = null,
  onGenerateAll,
  onRetryBeat,
  onImportMasterVideo,
  onBack,
  onWatchFinal,
  onWatchSlideshowFallback,
}) => {
  const [confirmingFallback, setConfirmingFallback] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const styleOption = VISUAL_STYLE_OPTIONS.find((s) => s.id === scene.style);
  const readyCount = storyboard.beats.filter(
    (b) =>
      beatMedia[b.id]?.status === 'ready' &&
      beatMedia[b.id]?.styleApplied === scene.style &&
      Boolean(beatMedia[b.id]?.audioBase64) &&
      Boolean(
        beatMedia[b.id]?.hasMovingVideo &&
          beatMedia[b.id]?.videoClips &&
          beatMedia[b.id]?.videoClips?.length
      )
  ).length;
  const allReady = readyCount === storyboard.beats.length;
  const hasAnyStarted = storyboard.beats.some(
    (b) =>
      beatMedia[b.id] &&
      (beatMedia[b.id].status !== 'idle' || Boolean(beatMedia[b.id].statusDetail))
  );
  const errorBeats = storyboard.beats.filter(
    (b) => beatMedia[b.id]?.status === 'error'
  );
  const firstErrorMedia = errorBeats.length > 0 ? beatMedia[errorBeats[0].id] : undefined;
  const isPaidKeyRequired = errorBeats.some(
    (b) => beatMedia[b.id]?.errorType === 'paid_key_required'
  );
  const isDailyExhausted = errorBeats.some(
    (b) => beatMedia[b.id]?.errorType === 'daily_quota_exhausted'
  );
  const retryWaitText = formatRetryDurationHuman(firstErrorMedia?.retryAfterSec);

  const clipSpecByBeat: Record<string, { clips: number; seconds: number }> = {
    hook: { clips: 1, seconds: 8 },
    problem: { clips: 2, seconds: 10 },
    turn: { clips: 1, seconds: 9 },
    close: { clips: 1, seconds: 8 },
  };
  const pendingBeats = storyboard.beats.filter((b) => {
    const m = beatMedia[b.id];
    return !(
      m?.status === 'ready' &&
      m.styleApplied === scene.style &&
      Boolean(m.audioBase64) &&
      Boolean(m.hasMovingVideo && m.videoClips && m.videoClips.length > 0)
    );
  });
  const remainingVideoClips = pendingBeats.reduce(
    (sum, b) => sum + (clipSpecByBeat[b.id]?.clips ?? 1),
    0
  );
  const remainingVideoSeconds = pendingBeats.reduce(
    (sum, b) => sum + (clipSpecByBeat[b.id]?.seconds ?? 8),
    0
  );
  const remainingVoiceLines = pendingBeats.reduce((sum, b) => {
    if (beatMedia[b.id]?.audioBase64) return sum;
    return sum + b.dialogue.filter((d) => d.line.trim().length > 0).length;
  }, 0);

  return (
    <section className="cinema-enter max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-32 md:pb-16 overflow-x-hidden">
      <div className="mb-8">
        <p className="text-xs sm:text-sm font-medium tracking-wide text-[#E5C9AD] mb-2">
          Act IV · Studio Production
        </p>
        <h1 className="font-display text-3xl sm:text-5xl font-bold text-[#F5F0E6] tracking-tight text-balance">
          Lights, Camera, Action!
        </h1>
        <p className="mt-3 text-base sm:text-lg text-[#F5F0E6]/80 leading-relaxed">
          Generating moving-character video clips sequentially in{' '}
          <span className="font-semibold text-[#E5C9AD]">
            {styleOption?.title || scene.style}
          </span>{' '}
          from your finalized storyboard images, synced with English voices and subtitles.
        </p>
      </div>

      {errorBeats.length > 0 && (
        <div
          role="alert"
          className="liquid-glass-panel mb-6 p-5 sm:p-6 rounded-[22px] text-[#F5F0E6] space-y-4 overflow-hidden"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#E5C9AD] shrink-0 mt-0.5" />
            <div className="space-y-1.5 min-w-0">
              <p className="font-display text-xl font-bold text-[#F5F0E6]">
                {isPaidKeyRequired
                  ? 'Moving-video generation requires a paid API key.'
                  : isDailyExhausted
                  ? 'Daily video generation limit reached.'
                  : 'Moving-video generation paused.'}
              </p>
              <p className="text-sm sm:text-base text-[#F5F0E6]/85 leading-relaxed">
                {firstErrorMedia?.errorMessage ||
                  'Full moving-character video generation could not complete right now.'}
              </p>
              {isPaidKeyRequired && (
                <p className="text-xs sm:text-sm text-[#E5C9AD]">
                  To film animated character clips, select a billing-enabled Gemini API key in{' '}
                  <span className="font-semibold">Settings &gt; Secrets</span> and retry.
                </p>
              )}
              {retryWaitText && !isPaidKeyRequired && (
                <p className="text-xs sm:text-sm font-medium text-[#E5C9AD]">
                  Retry available in {retryWaitText}.
                </p>
              )}
              {readyCount > 0 && (
                <p className="text-xs text-[#F5F0E6]/70">
                  {readyCount} completed {readyCount === 1 ? 'scene is' : 'scenes are'} already saved on disk and will be reused automatically.
                </p>
              )}
            </div>
          </div>

          {confirmingFallback ? (
            <div className="p-4 rounded-2xl bg-[#29151E]/85 border border-[#E5C9AD]/35 space-y-3">
              <p className="text-sm text-[#F5F0E6] leading-relaxed">
                <span className="font-semibold text-[#E5C9AD]">
                  Confirm Animated Slideshow Fallback:{' '}
                </span>
                Because full moving-video generation is currently unavailable, fallback mode will use your finalized still storyboard images with gentle camera motion while keeping the complete English voice dialogue, Live-action laugh track (when selected), and synchronized subtitles.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={isPreparingFallback}
                  onClick={onWatchSlideshowFallback}
                  className="liquid-glass-btn-light min-h-[44px] px-5 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                >
                  {isPreparingFallback ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-[#722F37]" />
                      Preparing Voices & Slideshow...
                    </>
                  ) : (
                    <>
                      <PlaySquare className="w-4 h-4 text-[#722F37]" />
                      Switch to Animated Slideshow
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={isPreparingFallback}
                  onClick={() => setConfirmingFallback(false)}
                  className="liquid-glass-btn-secondary min-h-[44px] px-4 py-2 rounded-full text-sm font-semibold"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                disabled={isGeneratingAll || isPreparingFallback || isImportingMaster}
                onClick={() => onRetryBeat(errorBeats[0].id)}
                className="liquid-glass-btn-primary min-h-[44px] px-5 py-2 rounded-full text-sm font-semibold disabled:opacity-45 disabled:cursor-not-allowed inline-flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4 text-[#E5C9AD]" />
                Retry Moving Video
              </button>

              {onImportMasterVideo && (
                <button
                  type="button"
                  disabled={isGeneratingAll || isPreparingFallback || isImportingMaster}
                  onClick={() => importInputRef.current?.click()}
                  className="liquid-glass-btn-secondary min-h-[44px] px-5 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-45"
                >
                  {isImportingMaster ? (
                    <Loader2 className="w-4 h-4 animate-spin text-[#E5C9AD]" />
                  ) : (
                    <Upload className="w-4 h-4 text-[#E5C9AD]" />
                  )}
                  Import Saved Video (.mp4)
                </button>
              )}

              <button
                type="button"
                disabled={isGeneratingAll || isPreparingFallback || isImportingMaster}
                onClick={() => setConfirmingFallback(true)}
                className="liquid-glass-btn-light min-h-[44px] px-5 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-45"
              >
                <PlaySquare className="w-4 h-4 text-[#722F37]" />
                Use Animated Slideshow Fallback
              </button>
            </div>
          )}

          {importMasterError && (
            <p className="text-xs text-[#E5C9AD]">{importMasterError}</p>
          )}

          {firstErrorMedia?.errorDiagnostics && (
            <details className="pt-2 border-t border-[#E5C9AD]/20 text-xs text-[#F5F0E6]/65">
              <summary className="cursor-pointer select-none hover:text-[#E5C9AD]">
                Technical diagnostics
              </summary>
              <pre className="mt-2 p-3 rounded-xl bg-black/30 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[#F5F0E6]/75">
                {firstErrorMedia.errorDiagnostics}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Frosted Theater Production Stage */}
      <div className="liquid-glass-panel rounded-[24px] p-5 sm:p-7 mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-5 mb-5 border-b border-[#E5C9AD]/20">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#722F37]/65 border border-[#E5C9AD]/35 flex items-center justify-center">
              <Film
                className={`w-5 h-5 text-[#E5C9AD] ${
                  isGeneratingAll ? 'animate-spin' : ''
                }`}
                style={{ animationDuration: '3s' }}
                aria-hidden="true"
              />
            </div>
            <div>
              <p className="font-display text-lg font-bold text-[#F5F0E6]">
                {storyboard.title}
              </p>
              <p className="text-xs font-mono tabular-nums text-[#E5C9AD]">
                {readyCount} of {storyboard.beats.length} moving video scenes ready ·{' '}
                {styleOption?.title || scene.style}
              </p>
            </div>
          </div>

          {!allReady && (
            <div className="flex flex-wrap items-center gap-2.5">
              {onImportMasterVideo && (
                <button
                  type="button"
                  disabled={isGeneratingAll || isPreparingFallback || isImportingMaster}
                  onClick={() => importInputRef.current?.click()}
                  className="liquid-glass-btn-secondary min-h-[46px] px-4 py-2.5 rounded-full text-sm font-semibold disabled:opacity-45 inline-flex items-center gap-2"
                >
                  {isImportingMaster ? (
                    <Loader2 className="w-4 h-4 animate-spin text-[#E5C9AD]" />
                  ) : (
                    <Upload className="w-4 h-4 text-[#E5C9AD]" />
                  )}
                  Import .mp4
                </button>
              )}
              <button
                type="button"
                disabled={isGeneratingAll || isPreparingFallback || isImportingMaster}
                onClick={() => {
                  setConfirmingFallback(false);
                  onGenerateAll();
                }}
                className="liquid-glass-btn-primary min-h-[46px] px-6 py-2.5 rounded-full text-base font-semibold active:scale-[0.98] disabled:opacity-45 disabled:cursor-not-allowed inline-flex items-center gap-2"
              >
                <Clapperboard className="w-5 h-5 text-[#E5C9AD]" />
                {isGeneratingAll
                  ? 'Filming Moving Clips...'
                  : hasAnyStarted
                  ? 'Resume Filming'
                  : 'Start Filming'}
              </button>
            </div>
          )}
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept="video/mp4,.mp4"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file && onImportMasterVideo) {
              onImportMasterVideo(file);
            }
          }}
        />

        {importMasterError && errorBeats.length === 0 && (
          <p className="mb-4 text-xs sm:text-sm text-[#E5C9AD]">{importMasterError}</p>
        )}

        {!allReady && (
          <div className="mb-5 px-4 py-3.5 rounded-2xl bg-[#29151E]/65 border border-[#E5C9AD]/22 text-xs sm:text-sm text-[#F5F0E6]/85 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <span className="font-semibold text-[#E5C9AD]">
                Estimated Scope ({styleOption?.title || scene.style} only):{' '}
              </span>
              <span>
                {remainingVideoClips} moving video {remainingVideoClips === 1 ? 'clip' : 'clips'} (
                {remainingVideoSeconds}s @ 720p 16:9)
                {remainingVoiceLines > 0
                  ? ` + ${remainingVoiceLines} voice ${remainingVoiceLines === 1 ? 'line' : 'lines'}`
                  : ' · Voices already cached'}
              </span>
            </div>
            <span className="text-[11px] sm:text-xs text-[#F5F0E6]/65">
              Billed per generated second on your paid Gemini API tier · No auto-retries
            </span>
          </div>
        )}

        {/* 4-Beat Production Queue */}
        <div className="space-y-3.5">
          {storyboard.beats.map((beat, idx) => {
            const media = beatMedia[beat.id];
            const status = media?.status || 'idle';

            return (
              <div
                key={beat.id}
                className="liquid-glass-ivory text-[#21191B] rounded-[18px] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2.5 text-xs sm:text-sm">
                    <span className="font-mono tabular-nums font-semibold text-[#722F37]">
                      {beat.timeRange}
                    </span>
                    <span aria-hidden="true" className="text-[#722F37]/40">
                      ·
                    </span>
                    <span className="font-display text-base font-bold text-[#21191B]">
                      0{idx + 1}. {beat.label}
                    </span>
                  </div>
                  <p className="text-sm sm:text-base text-[#21191B]/85 break-words">
                    {beat.dialogue.map((d) => `${d.speaker}: "${d.line}"`).join(' ')}
                  </p>
                  {status === 'ready' && media && (
                    <p className="text-xs sm:text-sm text-[#722F37] font-medium flex items-center gap-2 pt-1">
                      <Video className="w-4 h-4 shrink-0" />
                      <span>
                        Moving video ({media.videoClips?.length === 2
                          ? `${((media.videoClips[0].trimEndSec ?? 1.35) - (media.videoClips[0].trimStartSec ?? 0)).toFixed(2)}s laptop insert + reaction cut`
                          : media.videoClips?.[0]?.url?.startsWith('/api/video/master/')
                          ? '720p continuous master'
                          : '720p animated clip'}) · Voice synced ({media.audioDurationSec.toFixed(1)}s)
                        {scene.style === 'live_action' && beat.id === 'problem'
                          ? ' · Sitcom audience laugh'
                          : ''}
                      </span>
                    </p>
                  )}
                  {status === 'idle' && media?.statusDetail && (
                    <p className="text-xs sm:text-sm text-[#722F37]/85 font-medium pt-1 break-words">
                      {media.statusDetail}
                    </p>
                  )}
                  {status === 'error' && media?.errorMessage && (
                    <p className="text-xs sm:text-sm text-[#722F37] font-semibold pt-1 break-words">
                      {media.errorMessage}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {status === 'idle' && (
                    <span className="text-sm font-medium text-[#21191B]/45">
                      Queued
                    </span>
                  )}
                  {status === 'generating' && (
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-[#722F37]">
                      <Film
                        className="w-5 h-5 animate-spin text-[#722F37]"
                        style={{ animationDuration: '2s' }}
                      />
                      {media?.statusDetail || 'Filming clip...'}
                    </span>
                  )}
                  {status === 'ready' && (
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#722F37]">
                      <CheckCircle2 className="w-5 h-5 text-[#722F37]" />
                      In the Can
                    </span>
                  )}
                  {status === 'error' && (
                    <button
                      type="button"
                      disabled={isGeneratingAll || isPreparingFallback}
                      onClick={() => {
                        setConfirmingFallback(false);
                        onRetryBeat(beat.id);
                      }}
                      className="liquid-glass-btn-primary min-h-[42px] px-4 py-2 rounded-full text-sm font-semibold disabled:opacity-45 disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Retry Scene
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Navigation Capsule Buttons */}
      <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="liquid-glass-btn-secondary min-h-[50px] px-6 py-3 rounded-full text-base font-semibold flex items-center justify-center gap-2 active:scale-[0.98]"
        >
          <ArrowLeft className="w-5 h-5 text-[#E5C9AD]" />
          Back to Storyboard
        </button>

        <button
          type="button"
          disabled={!allReady}
          onClick={onWatchFinal}
          className="liquid-glass-btn-primary min-h-[54px] px-8 py-3.5 rounded-full text-lg font-semibold active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
        >
          Proceed to Screening
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </section>
  );
};
