import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Captions,
  Download,
  Film,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Upload,
} from 'lucide-react';
import {
  getActiveSubtitleCue,
  preloadStyleAssets,
  renderBeatFrame,
} from '../engine/sceneRenderer';
import {
  BeatId,
  DialogueTurn,
  ExpressionEntry,
  GeneratedBeatMedia,
  PersistedMasterVideoInfo,
  SceneSetup,
  StoryboardData,
  SubtitleCue,
} from '../types';
import { buildPhraseSubtitleCues } from '../utils/subtitleUtils';
import {
  loadMasterFromIndexedDb,
  saveMasterToIndexedDb,
} from '../utils/videoVault';
import {
  SelectedPreviewVoices,
  SpeechTurnPlan,
  buildSpeechTurnPlans,
  getSpeechParamsForSpeaker,
  isSpeechSynthesisSupported,
  loadBrowserVoices,
  selectDialoguePreviewVoices,
} from '../utils/previewSpeech';

interface FinalPlayerStepProps {
  storyboard: StoryboardData;
  scene: SceneSetup;
  expressions: ExpressionEntry[];
  beatMedia: Record<string, GeneratedBeatMedia>;
  slideshowFallbackMode?: boolean;
  persistedMaster?: PersistedMasterVideoInfo | null;
  onMasterReady?: (master: PersistedMasterVideoInfo) => void;
  onSelectSlideshowFallback?: () => void;
  onBackToStoryboard: () => void;
}

interface TimelineSegment {
  beatIndex: number;
  beatId: BeatId;
  label: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  dialogue: DialogueTurn[];
  subtitleCues: SubtitleCue[];
  speechPlans: SpeechTurnPlan[];
  media: GeneratedBeatMedia;
}

interface ActiveSpeechState {
  sessionId: number;
  turnKey: string;
  beatId: BeatId;
  speaker: string;
  startedPerfMs: number;
  charIndex: number | null;
  plan: SpeechTurnPlan;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export const FinalPlayerStep: React.FC<FinalPlayerStepProps> = ({
  storyboard,
  scene,
  expressions,
  beatMedia,
  slideshowFallbackMode = false,
  persistedMaster = null,
  onMasterReady,
  onSelectSlideshowFallback,
  onBackToStoryboard,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioClockRef = useRef<{
    audioCtx: AudioContext;
    startTimeSec: number;
    offsetSec: number;
  } | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const decodedBuffersRef = useRef<Record<string, AudioBuffer>>({});
  const videoElementsRef = useRef<Record<string, HTMLVideoElement>>({});
  const rafRef = useRef<number | null>(null);
  const playStartPerfMsRef = useRef<number>(0);

  const speechSessionIdRef = useRef<number>(0);
  const activeSpeechRef = useRef<ActiveSpeechState | null>(null);
  const completedSpeechTurnsRef = useRef<Set<string>>(new Set());
  const lastSpeechEndPerfMsRef = useRef<number>(0);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const masterVideoRef = useRef<HTMLVideoElement | null>(null);
  const pendingMasterRestoreRef = useRef<{ timeSec: number; shouldPlay: boolean } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const syncedIdbKeyRef = useRef<string>('');

  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const [masterMedia, setMasterMedia] = useState<{
    signature: string;
    cleanUrl: string;
    subtitledUrl: string;
    totalDurationSec: number;
    beatStarts: Record<string, { startSec: number; endSec: number; durationSec: number }>;
    isBlobFallback?: boolean;
  } | null>(null);
  const [isAssemblingMaster, setIsAssemblingMaster] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null);
  const [isImportingMaster, setIsImportingMaster] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [retryCounter, setRetryCounter] = useState(0);

  const [speechSupported] = useState<boolean>(() => isSpeechSynthesisSupported());
  const [previewVoices, setPreviewVoices] = useState<SelectedPreviewVoices>(() =>
    selectDialoguePreviewVoices([])
  );
  const [voicesReady, setVoicesReady] = useState(false);
  const [speechErrorNotice, setSpeechErrorNotice] = useState<string | null>(null);
  const [speechTimingConflict, setSpeechTimingConflict] = useState(false);

  const rawSegments: TimelineSegment[] = useMemo(() => {
    let cursor = 0;
    return storyboard.beats.map((beat, idx) => {
      const media = beatMedia[beat.id];
      const baseBeatSec = Math.max(5, beat.endSec - beat.startSec);
      const dur = media?.audioBase64
        ? Math.max(baseBeatSec, media.targetDurationSec || baseBeatSec)
        : baseBeatSec;
      const cues =
        media?.subtitleCues && media.subtitleCues.length > 0
          ? media.subtitleCues
          : buildPhraseSubtitleCues(beat.dialogue, dur);
      const speechPlans = buildSpeechTurnPlans(beat.dialogue, cues, dur);
      const seg: TimelineSegment = {
        beatIndex: idx,
        beatId: beat.id,
        label: beat.label,
        startSec: cursor,
        endSec: cursor + dur,
        durationSec: dur,
        dialogue: beat.dialogue,
        subtitleCues: cues,
        speechPlans,
        media,
      };
      cursor += dur;
      return seg;
    });
  }, [storyboard.beats, beatMedia]);

  const hasAllMovingVideo = useMemo(
    () =>
      rawSegments.every((s) =>
        Boolean(s.media?.hasMovingVideo && s.media?.videoClips && s.media.videoClips.length > 0)
      ),
    [rawSegments]
  );

  const hasAllServerAudio = useMemo(
    () => rawSegments.every((s) => Boolean(s.media?.audioBase64)),
    [rawSegments]
  );

  const hasAnyServerAudio = useMemo(
    () => rawSegments.some((s) => Boolean(s.media?.audioBase64)),
    [rawSegments]
  );

  const hasMatchingPersistedMaster = Boolean(
    persistedMaster && persistedMaster.style === scene.style && persistedMaster.cleanUrl
  );

  const shouldUseMasterMode =
    !slideshowFallbackMode && ((hasAllMovingVideo && hasAllServerAudio) || hasMatchingPersistedMaster);

  const masterSignature = useMemo(() => {
    if (!shouldUseMasterMode) return '';
    if (hasMatchingPersistedMaster && (!hasAllMovingVideo || !hasAllServerAudio) && persistedMaster) {
      return `persisted:${persistedMaster.style}:${persistedMaster.cleanUrl}:${persistedMaster.updatedAt}`;
    }
    return JSON.stringify({
      style: scene.style,
      beats: rawSegments.map((s) => ({
        beatId: s.beatId,
        dur: s.durationSec,
        clips: s.media?.videoClips?.map((c) => c.url) ?? [],
        cues: s.subtitleCues,
        audioLen: s.media?.audioBase64?.length ?? 0,
        audioSig: s.media?.audioBase64?.slice(96, 160) ?? '',
      })),
    });
  }, [
    shouldUseMasterMode,
    hasMatchingPersistedMaster,
    hasAllMovingVideo,
    hasAllServerAudio,
    persistedMaster,
    scene.style,
    rawSegments,
  ]);

  const useMasterVideo = Boolean(
    !slideshowFallbackMode &&
      masterMedia &&
      (masterMedia.isBlobFallback ||
        (shouldUseMasterMode &&
          (masterMedia.signature === masterSignature || hasMatchingPersistedMaster))) &&
      !masterError &&
      !videoPlaybackError
  );

  const segments: TimelineSegment[] = useMemo(() => {
    if (!useMasterVideo || !masterMedia) return rawSegments;
    return rawSegments.map((seg) => {
      const aligned = masterMedia.beatStarts[seg.beatId];
      if (!aligned) return seg;
      return {
        ...seg,
        startSec: aligned.startSec,
        endSec: aligned.endSec,
        durationSec: aligned.durationSec,
      };
    });
  }, [rawSegments, useMasterVideo, masterMedia]);

  const canUsePreviewSpeech =
    slideshowFallbackMode && !hasAllServerAudio && speechSupported && !speechErrorNotice;

  const totalDurationSec = useMemo(
    () =>
      useMasterVideo && masterMedia
        ? masterMedia.totalDurationSec
        : Number((segments.reduce((sum, s) => sum + s.durationSec, 0) || 30).toFixed(2)),
    [useMasterVideo, masterMedia, segments]
  );

  const hasTimingConflict = totalDurationSec > 31.2 || speechTimingConflict;

  // Immediately hydrate masterMedia from persistedMaster when available for instant screening
  useEffect(() => {
    if (slideshowFallbackMode) return;
    if (hasMatchingPersistedMaster && persistedMaster) {
      setMasterMedia((prev) => {
        if (
          prev &&
          prev.cleanUrl === persistedMaster.cleanUrl &&
          prev.subtitledUrl === persistedMaster.subtitledUrl &&
          !prev.isBlobFallback
        ) {
          return prev;
        }
        return {
          signature: masterSignature || `persisted:${persistedMaster.style}:${persistedMaster.cleanUrl}`,
          cleanUrl: persistedMaster.cleanUrl,
          subtitledUrl: persistedMaster.subtitledUrl,
          totalDurationSec: persistedMaster.totalDurationSec || 30,
          beatStarts: persistedMaster.beatStarts || {},
        };
      });
      setMasterError(null);
      setVideoPlaybackError(null);
    }
  }, [slideshowFallbackMode, hasMatchingPersistedMaster, persistedMaster, masterSignature]);

  useEffect(() => {
    if (!shouldUseMasterMode || !masterSignature) return;
    if (masterMedia && masterMedia.signature === masterSignature && !masterError && retryCounter === 0) {
      return;
    }

    // When persistedMaster already matches this style and raw clips aren't loaded yet, use it directly
    if (hasMatchingPersistedMaster && persistedMaster && (!hasAllMovingVideo || !hasAllServerAudio)) {
      return;
    }

    let cancelled = false;
    setIsAssemblingMaster(true);
    setMasterError(null);
    setVideoPlaybackError(null);

    fetch('/api/video/assemble-master', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        style: scene.style,
        title: storyboard.title,
        scenePlace: scene.place,
        sceneSituation: scene.situation,
        beats: rawSegments.map((s) => ({
          beatId: s.beatId,
          beatDurationSec: s.durationSec,
          clips: s.media?.videoClips ?? [],
          subtitleCues: s.subtitleCues,
          audioBase64: s.media?.audioBase64 ?? '',
          cutToBlackAtEnd: s.beatId === 'close' || Boolean(s.media?.sceneDirection?.cutToBlackAtEnd),
          hasLaughTrack: Boolean(s.media?.hasLaughTrack),
        })),
      }),
    })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.cleanUrl || !data?.subtitledUrl) {
          throw new Error(data?.error || 'Master video assembly failed.');
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setMasterMedia({
          signature: masterSignature,
          cleanUrl: data.cleanUrl,
          subtitledUrl: data.subtitledUrl,
          totalDurationSec: Number(data.totalDurationSec) || 30,
          beatStarts: data.beatStarts || {},
        });
        if (data.completedMaster && onMasterReady) {
          onMasterReady(data.completedMaster as PersistedMasterVideoInfo);
        }
      })
      .catch(async (err) => {
        if (cancelled) return;
        console.error('[CineLingo Master Video Error]', err);
        // Check browser IndexedDB binary vault before raising an error
        const idbRec = await loadMasterFromIndexedDb(scene.style);
        if (cancelled) return;
        if (idbRec) {
          const cleanObjUrl = URL.createObjectURL(idbRec.cleanBlob);
          const subObjUrl = URL.createObjectURL(idbRec.subtitledBlob);
          objectUrlsRef.current.push(cleanObjUrl, subObjUrl);
          setMasterMedia({
            signature: masterSignature,
            cleanUrl: cleanObjUrl,
            subtitledUrl: subObjUrl,
            totalDurationSec: idbRec.info.totalDurationSec || 30,
            beatStarts: idbRec.info.beatStarts || {},
            isBlobFallback: true,
          });
          setMasterError(null);
          return;
        }
        setMasterError(err instanceof Error ? err.message : 'Unable to load moving master video.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsAssemblingMaster(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    shouldUseMasterMode,
    masterSignature,
    masterMedia,
    masterError,
    retryCounter,
    hasMatchingPersistedMaster,
    persistedMaster,
    hasAllMovingVideo,
    hasAllServerAudio,
    scene.style,
    scene.place,
    scene.situation,
    storyboard.title,
    rawSegments,
    onMasterReady,
  ]);

  // Cache assembled HTTP master MP4 blobs into browser IndexedDB for offline/reload resilience
  useEffect(() => {
    if (!masterMedia || masterMedia.isBlobFallback || slideshowFallbackMode) return;
    if (!masterMedia.cleanUrl.startsWith('/api/') || !masterMedia.subtitledUrl.startsWith('/api/')) {
      return;
    }
    const syncKey = `${scene.style}|${masterMedia.cleanUrl}|${masterMedia.subtitledUrl}`;
    if (syncedIdbKeyRef.current === syncKey) return;

    let cancelled = false;
    (async () => {
      try {
        const existing = await loadMasterFromIndexedDb(scene.style);
        if (
          cancelled ||
          (existing &&
            existing.info.cleanUrl === masterMedia.cleanUrl &&
            existing.info.subtitledUrl === masterMedia.subtitledUrl)
        ) {
          syncedIdbKeyRef.current = syncKey;
          return;
        }
        const [cleanResp, subResp] = await Promise.all([
          fetch(masterMedia.cleanUrl),
          masterMedia.subtitledUrl === masterMedia.cleanUrl
            ? Promise.resolve(null)
            : fetch(masterMedia.subtitledUrl),
        ]);
        if (cancelled || !cleanResp.ok) return;
        const cleanBlob = await cleanResp.blob();
        const subtitledBlob =
          subResp && subResp.ok ? await subResp.blob() : cleanBlob;
        if (cancelled || cleanBlob.size < 4096) return;

        const subtitleCuesByBeat: Record<string, SubtitleCue[]> = {};
        const hasLaughTrackByBeat: Record<string, boolean> = {};
        for (const s of rawSegments) {
          subtitleCuesByBeat[s.beatId] = s.subtitleCues;
          hasLaughTrackByBeat[s.beatId] = Boolean(
            s.media?.hasLaughTrack || (scene.style === 'live_action' && s.beatId === 'problem')
          );
        }

        const info: PersistedMasterVideoInfo = persistedMaster ?? {
          style: scene.style,
          title: storyboard.title,
          scenePlace: scene.place,
          sceneSituation: scene.situation,
          cleanUrl: masterMedia.cleanUrl,
          subtitledUrl: masterMedia.subtitledUrl,
          totalDurationSec: masterMedia.totalDurationSec,
          beatStarts: masterMedia.beatStarts,
          subtitleCuesByBeat,
          hasLaughTrackByBeat,
          updatedAt: new Date().toISOString(),
        };

        await saveMasterToIndexedDb({
          style: scene.style,
          info,
          cleanBlob,
          subtitledBlob,
        });
        syncedIdbKeyRef.current = syncKey;
      } catch {
        // Non-fatal if background IndexedDB caching fails
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    masterMedia,
    slideshowFallbackMode,
    scene.style,
    scene.place,
    scene.situation,
    storyboard.title,
    rawSegments,
    persistedMaster,
  ]);

  useEffect(() => {
    let active = true;
    if (!speechSupported) {
      setVoicesReady(true);
      return;
    }
    loadBrowserVoices(1500).then((voices) => {
      if (!active) return;
      setPreviewVoices(selectDialoguePreviewVoices(voices));
      setVoicesReady(true);
    });
    return () => {
      active = false;
    };
  }, [speechSupported]);

  const findSegmentAt = useCallback(
    (timeSec: number): TimelineSegment => {
      for (const seg of segments) {
        if (timeSec < seg.endSec) return seg;
      }
      return segments[segments.length - 1];
    },
    [segments]
  );

  const stopAllVideoElements = useCallback(() => {
    for (const video of Object.values(videoElementsRef.current)) {
      try {
        if (!video.paused) video.pause();
      } catch {
        // Ignore pause errors
      }
    }
  }, []);

  const stopAllAudio = useCallback(() => {
    audioClockRef.current = null;
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already stopped source
      }
    }
    activeSourcesRef.current = [];

    stopAllVideoElements();

    speechSessionIdRef.current += 1;
    activeSpeechRef.current = null;
    activeUtteranceRef.current = null;
    completedSpeechTurnsRef.current.clear();

    if (isSpeechSynthesisSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore speech cancellation errors
      }
    }
  }, [stopAllVideoElements]);

  const ensureAudioBuffers = useCallback(async () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    for (const seg of segments) {
      const key = `${scene.style}:${seg.beatId}:${seg.media?.audioBase64?.length ?? 0}:${seg.media?.audioBase64?.slice(96, 128) ?? ''}`;
      if (seg.media?.audioBase64 && !decodedBuffersRef.current[key]) {
        const arrBuf = base64ToArrayBuffer(seg.media.audioBase64);
        const decoded = await ctx.decodeAudioData(arrBuf.slice(0));
        decodedBuffersRef.current[key] = decoded;
      }
    }
    return ctx;
  }, [segments, scene.style]);

  const resolvePreviewSpeechCue = useCallback(
    (seg: TimelineSegment): SubtitleCue | null => {
      const active = activeSpeechRef.current;
      if (!active || active.beatId !== seg.beatId) {
        return null;
      }

      const spans = active.plan.phraseSpans;
      if (spans.length === 0) return null;

      let chosenSpan = spans[0];
      if (active.charIndex !== null) {
        for (const span of spans) {
          if (active.charIndex >= span.charStart) {
            chosenSpan = span;
          }
        }
      } else {
        const spokenElapsed = Math.max(0, (performance.now() - active.startedPerfMs) / 1000);
        const estTurnDur = Math.max(
          1.2,
          active.plan.scheduledEndSec - active.plan.scheduledStartSec
        );
        const totalWeight = spans.reduce((sum, sp) => sum + sp.weight, 0) || 1;
        let accSec = 0;
        for (const span of spans) {
          const spanDur = (span.weight / totalWeight) * estTurnDur;
          chosenSpan = span;
          accSec += spanDur;
          if (spokenElapsed <= accSec) break;
        }
      }

      const matchingCue = seg.subtitleCues[chosenSpan.cueIndex];
      return {
        speaker: active.speaker,
        text: matchingCue?.text ?? chosenSpan.text,
        startSec: matchingCue?.startSec ?? active.plan.scheduledStartSec,
        endSec: matchingCue?.endSec ?? active.plan.scheduledEndSec,
      };
    },
    []
  );

  const flattenedClipTimeline = useMemo(() => {
    const entries: Array<{
      url: string;
      globalStartSec: number;
      globalEndSec: number;
      trimStartSec: number;
      trimEndSec?: number;
      playbackRate: number;
    }> = [];

    for (const seg of segments) {
      const clips = seg.media?.videoClips;
      if (!seg.media?.hasMovingVideo || !clips || clips.length === 0) continue;

      if (seg.beatId === 'problem' && clips.length >= 2) {
        const c0Start = clips[0].trimStartSec ?? 0;
        const c0Rate = clips[0].playbackRate ?? 1;
        const insertCutoff =
          clips[0].trimEndSec !== undefined
            ? Math.max(0.5, (clips[0].trimEndSec - c0Start) / c0Rate)
            : Math.min(2.0, 1.75, seg.durationSec * 0.4);

        entries.push({
          url: clips[0].url,
          globalStartSec: seg.startSec,
          globalEndSec: seg.startSec + insertCutoff,
          trimStartSec: c0Start,
          trimEndSec: clips[0].trimEndSec,
          playbackRate: c0Rate,
        });
        entries.push({
          url: clips[1].url,
          globalStartSec: seg.startSec + insertCutoff,
          globalEndSec: seg.endSec,
          trimStartSec: clips[1].trimStartSec ?? 0,
          trimEndSec: clips[1].trimEndSec,
          playbackRate: clips[1].playbackRate ?? 1,
        });
      } else {
        entries.push({
          url: clips[0].url,
          globalStartSec: seg.startSec,
          globalEndSec: seg.endSec,
          trimStartSec: clips[0].trimStartSec ?? 0,
          trimEndSec: clips[0].trimEndSec,
          playbackRate: clips[0].playbackRate ?? 1,
        });
      }
    }
    return entries;
  }, [segments]);

  const clipPlaybackByUrl = useMemo(() => {
    const map: Record<string, { trimStartSec: number; playbackRate: number }> = {};
    for (const entry of flattenedClipTimeline) {
      if (!map[entry.url]) {
        map[entry.url] = {
          trimStartSec: entry.trimStartSec,
          playbackRate: entry.playbackRate,
        };
      }
    }
    return map;
  }, [flattenedClipTimeline]);

  const resolveClipAtBeatTime = useCallback(
    (
      seg: TimelineSegment,
      beatElapsed: number
    ): {
      url: string;
      clipTimeSec: number;
      playbackRate: number;
      trimEndSec?: number;
      remainingInClipSec: number;
    } | null => {
      const clips = seg.media?.videoClips;
      if (!seg.media?.hasMovingVideo || !clips || clips.length === 0) {
        return null;
      }

      if (seg.beatId === 'problem' && clips.length >= 2) {
        const c0Start = clips[0].trimStartSec ?? 0;
        const c0Rate = clips[0].playbackRate ?? 1;
        const insertCutoff =
          clips[0].trimEndSec !== undefined
            ? Math.max(0.5, (clips[0].trimEndSec - c0Start) / c0Rate)
            : Math.min(2.0, 1.75, seg.durationSec * 0.4);
        if (beatElapsed < insertCutoff) {
          return {
            url: clips[0].url,
            clipTimeSec: c0Start + beatElapsed * c0Rate,
            playbackRate: c0Rate,
            trimEndSec: clips[0].trimEndSec,
            remainingInClipSec: Math.max(0, insertCutoff - beatElapsed),
          };
        }
        const c1Start = clips[1].trimStartSec ?? 0;
        const c1Rate = clips[1].playbackRate ?? 1;
        return {
          url: clips[1].url,
          clipTimeSec: c1Start + (beatElapsed - insertCutoff) * c1Rate,
          playbackRate: c1Rate,
          trimEndSec: clips[1].trimEndSec,
          remainingInClipSec: Math.max(0, seg.durationSec - beatElapsed),
        };
      }

      const c0Start = clips[0].trimStartSec ?? 0;
      const c0Rate = clips[0].playbackRate ?? 1;
      return {
        url: clips[0].url,
        clipTimeSec: c0Start + beatElapsed * c0Rate,
        playbackRate: c0Rate,
        trimEndSec: clips[0].trimEndSec,
        remainingInClipSec: Math.max(0, seg.durationSec - beatElapsed),
      };
    },
    []
  );

  const syncActiveVideoElement = useCallback(
    (
      seg: TimelineSegment,
      beatElapsed: number,
      playingNow: boolean,
      totalElapsedSec?: number
    ): HTMLVideoElement | null => {
      const target = resolveClipAtBeatTime(seg, beatElapsed);
      if (!target) {
        stopAllVideoElements();
        return null;
      }

      const activeVideo = videoElementsRef.current[target.url] ?? null;
      for (const [url, vid] of Object.entries(videoElementsRef.current)) {
        if (url !== target.url && !vid.paused) {
          try {
            vid.pause();
          } catch {
            // Ignore pause failure
          }
        }
      }

      // Pre-warm the next clip ~0.75s ahead of a cut so transitions start on the exact entry frame with zero decode stall
      if (playingNow && target.remainingInClipSec <= 0.75 && totalElapsedSec !== undefined) {
        const currentClipEndGlobal = totalElapsedSec + target.remainingInClipSec;
        const nextEntry = flattenedClipTimeline.find(
          (entry) => entry.globalStartSec >= currentClipEndGlobal - 0.05 && entry.url !== target.url
        );
        if (nextEntry) {
          const nextVid = videoElementsRef.current[nextEntry.url];
          if (
            nextVid &&
            nextVid.readyState >= 1 &&
            nextVid.paused &&
            !nextVid.seeking &&
            Math.abs(nextVid.currentTime - nextEntry.trimStartSec) > 0.04
          ) {
            try {
              nextVid.playbackRate = nextEntry.playbackRate;
              nextVid.currentTime = nextEntry.trimStartSec;
            } catch {
              // Ignore pre-seek error before metadata ready
            }
          }
        }
      }

      if (!activeVideo) return null;

      const mediaDurBound =
        Number.isFinite(activeVideo.duration) && activeVideo.duration > 0.1
          ? Math.max(0, activeVideo.duration - 0.03)
          : target.clipTimeSec;
      const trimUpperBound =
        typeof target.trimEndSec === 'number' && target.trimEndSec > 0.2
          ? Math.min(mediaDurBound, target.trimEndSec)
          : mediaDurBound;
      const desiredTime = Math.max(0, Math.min(target.clipTimeSec, trimUpperBound));

      if (playingNow) {
        const driftSec = desiredTime - activeVideo.currentTime;
        if (!activeVideo.seeking) {
          if (Math.abs(driftSec) > 0.09) {
            try {
              activeVideo.playbackRate = target.playbackRate;
              activeVideo.currentTime = desiredTime;
            } catch {
              // Ignore seek before metadata ready
            }
          } else if (Math.abs(driftSec) > 0.02) {
            // Gently nudge playbackRate to erase small micro-drift without choppy frame jumps
            const nudgedRate = Math.max(
              target.playbackRate * 0.9,
              Math.min(target.playbackRate * 1.12, target.playbackRate + driftSec * 0.85)
            );
            activeVideo.playbackRate = nudgedRate;
          } else if (Math.abs(activeVideo.playbackRate - target.playbackRate) > 0.01) {
            activeVideo.playbackRate = target.playbackRate;
          }
        }

        if (activeVideo.paused && desiredTime < trimUpperBound - 0.04) {
          activeVideo.play().catch(() => {});
        }
      } else {
        if (!activeVideo.paused) {
          try {
            activeVideo.pause();
          } catch {
            // Ignore pause error
          }
        }
        if (Math.abs(activeVideo.playbackRate - target.playbackRate) > 0.01) {
          activeVideo.playbackRate = target.playbackRate;
        }
        if (!activeVideo.seeking && Math.abs(activeVideo.currentTime - desiredTime) > 0.02) {
          try {
            activeVideo.currentTime = desiredTime;
          } catch {
            // Ignore seek before metadata ready
          }
        }
      }

      return activeVideo;
    },
    [flattenedClipTimeline, resolveClipAtBeatTime, stopAllVideoElements]
  );

  const drawAtTime = useCallback(
    (timeSec: number, playingNow: boolean, startedNow = hasStartedPlayback) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const seg = findSegmentAt(timeSec);
      if (!seg || !seg.media) return;

      const beatElapsed = Math.max(0, timeSec - seg.startSec);
      const isGeminiAudioBeat = Boolean(seg.media?.audioBase64);
      const useActiveSpeechSync =
        !isGeminiAudioBeat && canUsePreviewSpeech && playingNow && startedNow;

      const cue = useActiveSpeechSync
        ? resolvePreviewSpeechCue(seg)
        : getActiveSubtitleCue(seg.subtitleCues, beatElapsed);

      const lastCueEndSec =
        seg.subtitleCues.length > 0
          ? seg.subtitleCues[seg.subtitleCues.length - 1].endSec
          : undefined;

      // Clear subtitles before playback starts, during silent pauses, and after playback ends
      const withinActivePlaybackWindow =
        (startedNow || playingNow || timeSec > 0.02) &&
        (timeSec < totalDurationSec - 0.05 || Boolean(activeSpeechRef.current));
      const visibleSubtitle =
        showSubtitles && withinActivePlaybackWindow && cue ? cue.text : '';

      const activeVideoElement = syncActiveVideoElement(seg, beatElapsed, playingNow, timeSec);

      renderBeatFrame({
        ctx,
        width: canvas.width,
        height: canvas.height,
        style: scene.style,
        storyboard,
        direction: seg.media.sceneDirection,
        beatId: seg.beatId,
        beatElapsedSec: beatElapsed,
        beatDurationSec: seg.durationSec,
        activeSpeaker: cue?.speaker ?? null,
        isPlayingAudio: playingNow && Boolean(cue),
        activeVideoElement,
        lastCueEndSec,
        subtitleText: visibleSubtitle,
        renderSubtitlesOnCanvas: showSubtitles && Boolean(visibleSubtitle),
      });
    },
    [
      canUsePreviewSpeech,
      findSegmentAt,
      hasStartedPlayback,
      resolvePreviewSpeechCue,
      scene.style,
      showSubtitles,
      storyboard,
      syncActiveVideoElement,
      totalDurationSec,
    ]
  );

  const latestRenderRef = useRef({
    currentTimeSec,
    isPlaying,
    drawAtTime,
    clipPlaybackByUrl,
  });
  latestRenderRef.current = {
    currentTimeSec,
    isPlaying,
    drawAtTime,
    clipPlaybackByUrl,
  };

  useEffect(() => {
    // Do not pre-allocate 5 separate <video> elements when playing the single continuous master MP4
    if (shouldUseMasterMode && !masterError) {
      return;
    }

    const urls = new Set<string>();
    for (const seg of segments) {
      if (seg.media?.hasMovingVideo && seg.media.videoClips) {
        for (const clip of seg.media.videoClips) {
          if (clip.url) urls.add(clip.url);
        }
      }
    }

    for (const url of urls) {
      if (!videoElementsRef.current[url]) {
        const video = document.createElement('video');
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
        video.onloadedmetadata = () => {
          const entry = latestRenderRef.current.clipPlaybackByUrl[url];
          if (entry && video.paused) {
            try {
              video.playbackRate = entry.playbackRate;
              if (Math.abs(video.currentTime - entry.trimStartSec) > 0.03) {
                video.currentTime = entry.trimStartSec;
              }
            } catch {
              // Ignore pre-seek before ready
            }
          }
        };
        video.onloadeddata = () => {
          const latest = latestRenderRef.current;
          latest.drawAtTime(latest.currentTimeSec, latest.isPlaying);
        };
        video.onseeked = () => {
          const latest = latestRenderRef.current;
          if (!latest.isPlaying) {
            latest.drawAtTime(latest.currentTimeSec, false);
          }
        };
        video.load();
        videoElementsRef.current[url] = video;
      }
    }
  }, [segments, shouldUseMasterMode, masterError]);

  useEffect(() => {
    preloadStyleAssets(scene.style)
      .then(() => {
        if (!useMasterVideo && !latestRenderRef.current.isPlaying) {
          latestRenderRef.current.drawAtTime(latestRenderRef.current.currentTimeSec, false);
        }
      })
      .catch(() => {});
  }, [scene.style, useMasterVideo]);

  useEffect(() => {
    if (!useMasterVideo && !isPlaying) {
      drawAtTime(currentTimeSec, false);
    }
  }, [currentTimeSec, isPlaying, drawAtTime, useMasterVideo]);

  const speakTurnPlan = useCallback(
    (seg: TimelineSegment, plan: SpeechTurnPlan, sessionId: number) => {
      if (!isSpeechSynthesisSupported()) return;
      if (speechSessionIdRef.current !== sessionId) return;

      const synth = window.speechSynthesis;
      if (synth.paused) {
        synth.resume();
      }

      const freshVoices = selectDialoguePreviewVoices(synth.getVoices());
      const voicesToUse = freshVoices.emmaVoice ? freshVoices : previewVoices;
      const params = getSpeechParamsForSpeaker(plan.speaker, voicesToUse);

      // Speak strictly the approved English dialogue line (never character names or scene notes)
      const utterance = new SpeechSynthesisUtterance(plan.line);
      if (params.voice) {
        utterance.voice = params.voice;
      }
      utterance.lang = params.lang;
      utterance.rate = params.rate;
      utterance.pitch = params.pitch;
      utterance.volume = 1;

      const turnKey = `${seg.beatId}:${plan.turnIndex}`;
      activeUtteranceRef.current = utterance;
      activeSpeechRef.current = {
        sessionId,
        turnKey,
        beatId: seg.beatId,
        speaker: plan.speaker,
        startedPerfMs: performance.now(),
        charIndex: null,
        plan,
      };

      utterance.onstart = () => {
        if (speechSessionIdRef.current !== sessionId) return;
        if (activeSpeechRef.current && activeSpeechRef.current.turnKey === turnKey) {
          activeSpeechRef.current.startedPerfMs = performance.now();
        }
      };

      utterance.onboundary = (event) => {
        if (speechSessionIdRef.current !== sessionId) return;
        if (
          typeof event.charIndex === 'number' &&
          activeSpeechRef.current &&
          activeSpeechRef.current.turnKey === turnKey
        ) {
          activeSpeechRef.current.charIndex = event.charIndex;
        }
      };

      utterance.onend = () => {
        if (speechSessionIdRef.current !== sessionId) return;
        completedSpeechTurnsRef.current.add(turnKey);
        if (activeSpeechRef.current?.turnKey === turnKey) {
          activeSpeechRef.current = null;
        }
        activeUtteranceRef.current = null;
        lastSpeechEndPerfMsRef.current = performance.now();
      };

      utterance.onerror = (event) => {
        if (speechSessionIdRef.current !== sessionId) return;
        const errCode = event?.error || 'unknown';
        if (errCode === 'canceled' || errCode === 'interrupted') {
          return;
        }
        completedSpeechTurnsRef.current.add(turnKey);
        activeSpeechRef.current = null;
        activeUtteranceRef.current = null;
        lastSpeechEndPerfMsRef.current = performance.now();
        if (errCode === 'not-allowed') {
          setSpeechErrorNotice(
            'Browser blocked preview speech playback. Click Play or unmute audio to listen.'
          );
        } else {
          setSpeechErrorNotice(
            'Browser preview voice was unavailable; continuing with silent visual preview.'
          );
        }
      };

      synth.speak(utterance);
    },
    [previewVoices]
  );

  const syncSpeechAtTime = useCallback(
    (elapsedSec: number, sessionId: number) => {
      if (!speechSupported || speechErrorNotice) return;
      if (speechSessionIdRef.current !== sessionId) return;
      // Never start a second utterance while one is speaking (prevents overlap)
      if (activeSpeechRef.current) return;

      const now = performance.now();
      if (now - lastSpeechEndPerfMsRef.current < 120) {
        return;
      }

      for (const seg of segments) {
        if (seg.media?.audioBase64) continue;
        for (const plan of seg.speechPlans) {
          const turnKey = `${seg.beatId}:${plan.turnIndex}`;
          if (completedSpeechTurnsRef.current.has(turnKey)) continue;

          const globalStart = seg.startSec + plan.scheduledStartSec;
          const globalEnd = seg.startSec + plan.scheduledEndSec;

          if (elapsedSec + 0.08 >= globalStart) {
            if (elapsedSec > globalEnd + 0.25) {
              setSpeechTimingConflict(true);
            }
            speakTurnPlan(seg, plan, sessionId);
            return;
          }
          // Wait cleanly until the next chronological uncompleted turn's start time
          return;
        }
      }
    },
    [segments, speakTurnPlan, speechErrorNotice, speechSupported]
  );

  const schedulePlaybackFrom = useCallback(
    async (startOffsetSec: number) => {
      stopAllAudio();
      const sessionId = speechSessionIdRef.current;
      setSpeechTimingConflict(false);
      setSpeechErrorNotice(null);

      // Mark turns before startOffsetSec as skipped so seeking never replays earlier lines
      for (const seg of segments) {
        if (seg.media?.audioBase64) continue;
        for (const plan of seg.speechPlans) {
          const globalEnd = seg.startSec + plan.scheduledEndSec;
          if (globalEnd <= startOffsetSec + 0.05) {
            completedSpeechTurnsRef.current.add(`${seg.beatId}:${plan.turnIndex}`);
          }
        }
      }

      // Synchronously unlock/start initial browser speech inside user-gesture stack when needed
      if (!hasAllServerAudio && speechSupported) {
        const startSeg = findSegmentAt(startOffsetSec);
        if (startSeg && !startSeg.media?.audioBase64) {
          const initialPlan = startSeg.speechPlans.find((plan) => {
            const turnKey = `${startSeg.beatId}:${plan.turnIndex}`;
            if (completedSpeechTurnsRef.current.has(turnKey)) return false;
            const globalStart = startSeg.startSec + plan.scheduledStartSec;
            const globalEnd = startSeg.startSec + plan.scheduledEndSec;
            return startOffsetSec + 0.25 >= globalStart && startOffsetSec < globalEnd;
          });
          if (initialPlan) {
            speakTurnPlan(startSeg, initialPlan, sessionId);
          }
        }
      }

      let audioLeadSec = 0;
      if (hasAnyServerAudio) {
        const ctx = await ensureAudioBuffers();
        if (speechSessionIdRef.current !== sessionId) return;
        const now = ctx.currentTime + 0.05;
        audioLeadSec = 0.05;

        for (const seg of segments) {
          const key = `${scene.style}:${seg.beatId}:${seg.media?.audioBase64?.length ?? 0}:${seg.media?.audioBase64?.slice(96, 128) ?? ''}`;
          const buf = decodedBuffersRef.current[key];
          if (!buf) continue;
          if (seg.endSec <= startOffsetSec) continue;

          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);

          if (startOffsetSec <= seg.startSec) {
            const delay = seg.startSec - startOffsetSec;
            src.start(now + delay);
          } else {
            const skipInsideBeat = startOffsetSec - seg.startSec;
            if (skipInsideBeat < buf.duration) {
              src.start(now, skipInsideBeat);
            }
          }
          activeSourcesRef.current.push(src);
        }

        // Anchor the master playback clock directly to Web Audio's hardware sample clock
        audioClockRef.current = {
          audioCtx: ctx,
          startTimeSec: now,
          offsetSec: startOffsetSec,
        };
      }

      // Pre-seek initial clip to exact entry frame immediately before starting RAF playback loop
      const startSeg = findSegmentAt(startOffsetSec);
      if (startSeg) {
        const startBeatElapsed = Math.max(0, startOffsetSec - startSeg.startSec);
        syncActiveVideoElement(startSeg, startBeatElapsed, true, startOffsetSec);
      }

      // Single unified master timeline clock driving audio, subtitles, and scene frames together
      playStartPerfMsRef.current =
        performance.now() + audioLeadSec * 1000 - startOffsetSec * 1000;
      setHasStartedPlayback(true);
      setIsPlaying(true);
    },
    [
      ensureAudioBuffers,
      findSegmentAt,
      hasAllServerAudio,
      hasAnyServerAudio,
      segments,
      speakTurnPlan,
      speechSupported,
      stopAllAudio,
      syncActiveVideoElement,
    ]
  );

  const pausePlayback = useCallback(() => {
    if (useMasterVideo && masterVideoRef.current) {
      try {
        masterVideoRef.current.pause();
      } catch {
        // Ignore pause error
      }
      setIsPlaying(false);
      return;
    }
    stopAllAudio();
    setIsPlaying(false);
  }, [stopAllAudio, useMasterVideo]);

  // Smoothly mirror master <video> playback position to UI timeline using requestVideoFrameCallback (~15Hz)
  // without ever touching video.currentTime or playbackRate during playback.
  useEffect(() => {
    if (!useMasterVideo || !isPlaying) return;
    const vid = masterVideoRef.current;
    if (!vid) return;

    let cancelled = false;
    let lastSyncMs = 0;
    let lastShownSec = -1;
    let rvfcId: number | null = null;
    let rafId: number | null = null;

    type RvfcVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    const rVid = vid as RvfcVideo;

    const updateTimeline = (nowMs: number) => {
      if (cancelled) return;
      const t = vid.currentTime;
      if (nowMs - lastSyncMs >= 66 || Math.abs(t - lastShownSec) >= 0.08) {
        lastSyncMs = nowMs;
        lastShownSec = t;
        setCurrentTimeSec(t);
      }
    };

    if (typeof rVid.requestVideoFrameCallback === 'function') {
      const onFrame = (nowMs: number) => {
        if (cancelled) return;
        updateTimeline(nowMs);
        rvfcId = rVid.requestVideoFrameCallback!(onFrame);
      };
      rvfcId = rVid.requestVideoFrameCallback(onFrame);
      return () => {
        cancelled = true;
        if (rvfcId !== null && typeof rVid.cancelVideoFrameCallback === 'function') {
          rVid.cancelVideoFrameCallback(rvfcId);
        }
      };
    }

    const onRaf = (nowMs: number) => {
      if (cancelled) return;
      updateTimeline(nowMs);
      rafId = requestAnimationFrame(onRaf);
    };
    rafId = requestAnimationFrame(onRaf);
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [useMasterVideo, isPlaying]);

  useEffect(() => {
    if (useMasterVideo || !isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const sessionId = speechSessionIdRef.current;

    const tick = () => {
      if (speechSessionIdRef.current !== sessionId) return;
      const clock = audioClockRef.current;
      const elapsed = clock
        ? Math.max(0, clock.offsetSec + (clock.audioCtx.currentTime - clock.startTimeSec))
        : Math.max(0, (performance.now() - playStartPerfMsRef.current) / 1000);

      syncSpeechAtTime(elapsed, sessionId);

      if (elapsed >= totalDurationSec) {
        // Never truncate mid-sentence if browser preview voice is still finishing the final words
        if (activeSpeechRef.current) {
          setSpeechTimingConflict(true);
          setCurrentTimeSec(totalDurationSec);
          drawAtTime(totalDurationSec - 0.02, true, true);
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        stopAllAudio();
        setIsPlaying(false);
        setCurrentTimeSec(totalDurationSec);
        drawAtTime(totalDurationSec, false, true);
        return;
      }

      setCurrentTimeSec(elapsed);
      drawAtTime(elapsed, true, true);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [useMasterVideo, isPlaying, totalDurationSec, drawAtTime, stopAllAudio, syncSpeechAtTime]);

  useEffect(() => {
    const handleUnload = () => {
      stopAllAudio();
      if (masterVideoRef.current && !masterVideoRef.current.paused) {
        try {
          masterVideoRef.current.pause();
        } catch {
          // Ignore pause errors
        }
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      stopAllAudio();
      if (masterVideoRef.current) {
        try {
          masterVideoRef.current.pause();
        } catch {
          // Ignore pause errors
        }
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      for (const vid of Object.values(videoElementsRef.current)) {
        try {
          vid.pause();
          vid.removeAttribute('src');
          vid.load();
        } catch {
          // Ignore cleanup errors
        }
      }
      videoElementsRef.current = {};
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
      for (const objUrl of objectUrlsRef.current) {
        try {
          URL.revokeObjectURL(objUrl);
        } catch {
          // Ignore revoke errors
        }
      }
      objectUrlsRef.current = [];
    };
  }, [stopAllAudio]);

  const togglePlay = () => {
    if (useMasterVideo && masterVideoRef.current) {
      const vid = masterVideoRef.current;
      if (!vid.paused && !vid.ended) {
        vid.pause();
        setIsPlaying(false);
      } else {
        if (vid.ended || vid.currentTime >= totalDurationSec - 0.15) {
          vid.currentTime = 0;
          setCurrentTimeSec(0);
        }
        setHasStartedPlayback(true);
        setIsPlaying(true);
        vid.play().catch((err) => {
          console.error('[CineLingo Master Playback Error]', err);
          setIsPlaying(false);
        });
      }
      return;
    }

    if (isPlaying) {
      pausePlayback();
    } else {
      const startFrom = currentTimeSec >= totalDurationSec - 0.15 ? 0 : currentTimeSec;
      schedulePlaybackFrom(startFrom);
    }
  };

  const handleRestartFromBeginning = () => {
    if (useMasterVideo && masterVideoRef.current) {
      const vid = masterVideoRef.current;
      vid.currentTime = 0;
      setCurrentTimeSec(0);
      setHasStartedPlayback(true);
      setIsPlaying(true);
      vid.play().catch((err) => {
        console.error('[CineLingo Master Restart Error]', err);
        setIsPlaying(false);
      });
      return;
    }
    setCurrentTimeSec(0);
    schedulePlaybackFrom(0);
  };

  const handleToggleSubtitles = () => {
    if (useMasterVideo && masterVideoRef.current && masterMedia) {
      const vid = masterVideoRef.current;
      if (masterMedia.cleanUrl !== masterMedia.subtitledUrl) {
        pendingMasterRestoreRef.current = {
          timeSec: vid.currentTime,
          shouldPlay: !vid.paused && !vid.ended,
        };
      }
    }
    setShowSubtitles((s) => !s);
  };

  const handleRetryMovingVideo = async () => {
    setMasterError(null);
    setVideoPlaybackError(null);
    setImportError(null);
    const idbRec = await loadMasterFromIndexedDb(scene.style);
    if (persistedMaster && persistedMaster.style === scene.style) {
      setMasterMedia({
        signature: masterSignature || `persisted:${persistedMaster.style}:${persistedMaster.cleanUrl}`,
        cleanUrl: persistedMaster.cleanUrl,
        subtitledUrl: persistedMaster.subtitledUrl,
        totalDurationSec: persistedMaster.totalDurationSec || 30,
        beatStarts: persistedMaster.beatStarts || {},
      });
    } else if (idbRec && (!hasAllMovingVideo || !hasAllServerAudio)) {
      const cleanObjUrl = URL.createObjectURL(idbRec.cleanBlob);
      const subObjUrl = URL.createObjectURL(idbRec.subtitledBlob);
      objectUrlsRef.current.push(cleanObjUrl, subObjUrl);
      setMasterMedia({
        signature: masterSignature || `idb:${scene.style}`,
        cleanUrl: cleanObjUrl,
        subtitledUrl: subObjUrl,
        totalDurationSec: idbRec.info.totalDurationSec || 30,
        beatStarts: idbRec.info.beatStarts || {},
        isBlobFallback: true,
      });
    } else {
      setMasterMedia(null);
      setRetryCounter((c) => c + 1);
    }
  };

  const handleImportMasterFile = async (file: File) => {
    if (isImportingMaster) return;
    setIsImportingMaster(true);
    setImportError(null);
    setMasterError(null);
    setVideoPlaybackError(null);
    try {
      const params = new URLSearchParams({
        style: scene.style,
        title: storyboard.title,
        place: scene.place,
        situation: scene.situation,
      });
      const resp = await fetch(`/api/video/import-master?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'video/mp4' },
        body: file,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.master) {
        throw new Error(data?.error || 'Could not import the selected MP4 video.');
      }
      const imported = data.master as PersistedMasterVideoInfo;
      await saveMasterToIndexedDb({
        style: scene.style,
        info: imported,
        cleanBlob: file,
        subtitledBlob: file,
      });
      setMasterMedia({
        signature: `imported:${imported.style}:${imported.cleanUrl}:${imported.updatedAt}`,
        cleanUrl: imported.cleanUrl,
        subtitledUrl: imported.subtitledUrl,
        totalDurationSec: imported.totalDurationSec,
        beatStarts: imported.beatStarts || {},
      });
      if (onMasterReady) {
        onMasterReady(imported);
      }
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Unable to import the selected MP4 file.'
      );
    } finally {
      setIsImportingMaster(false);
    }
  };

  const jumpToTime = (sec: number) => {
    const clamped = Math.max(0, Math.min(totalDurationSec, sec));
    setCurrentTimeSec(clamped);
    if (useMasterVideo && masterVideoRef.current) {
      masterVideoRef.current.currentTime = clamped;
      return;
    }
    if (isPlaying) {
      schedulePlaybackFrom(clamped);
    } else {
      stopAllAudio();
      drawAtTime(clamped, false);
    }
  };

  const handleDownloadVideo = async () => {
    if (isExporting || (!hasAllServerAudio && !(useMasterVideo && masterMedia))) return;

    if (useMasterVideo && masterMedia) {
      pausePlayback();
      setIsExporting(true);
      setExportProgress(25);
      setExportMessage('Preparing MP4 download...');
      try {
        const masterUrl = showSubtitles ? masterMedia.subtitledUrl : masterMedia.cleanUrl;
        const resp = await fetch(masterUrl);
        if (!resp.ok) {
          throw new Error('Failed to retrieve master MP4.');
        }
        setExportProgress(75);
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = 'CineLingo-30s-clip.mp4';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
        setExportProgress(100);
        setExportMessage('Downloaded CineLingo-30s-clip.mp4!');
      } catch (err) {
        console.error('[CineLingo MP4 Download Error]', err);
        setExportMessage('Video download failed in this browser.');
      } finally {
        setIsExporting(false);
      }
      return;
    }

    pausePlayback();
    setIsExporting(true);
    setExportProgress(0);
    setExportMessage('Preparing audio & video recorder...');

    try {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = 1280;
      exportCanvas.height = 720;
      const eCtx = exportCanvas.getContext('2d');
      if (!eCtx) throw new Error('Canvas 2D context unavailable.');

      const audioCtx = await ensureAudioBuffers();
      const dest = audioCtx.createMediaStreamDestination();

      const canvasStream = exportCanvas.captureStream(30);
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';

      const recorder = mimeType
        ? new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 3_500_000 })
        : new MediaRecorder(combinedStream);

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      const donePromise = new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
        };
      });

      await preloadStyleAssets(scene.style).catch(() => {});

      // Ensure all moving video clips are pre-buffered and pre-seeked to each clip's synchronized trimStartSec
      if (hasAllMovingVideo) {
        setExportMessage('Buffering moving video clips for export...');
        const waitPromises = Object.entries(videoElementsRef.current).map(
          ([url, video]) =>
            new Promise<void>((resolve) => {
              video.muted = true;
              const entryConfig = clipPlaybackByUrl[url];
              const targetEntrySec = entryConfig?.trimStartSec ?? 0;
              const targetRate = entryConfig?.playbackRate ?? 1;
              const needsSeek = Math.abs(video.currentTime - targetEntrySec) > 0.02;
              try {
                video.pause();
                video.playbackRate = targetRate;
                if (needsSeek) {
                  video.currentTime = targetEntrySec;
                }
              } catch {
                // Ignore seek error before metadata
              }

              let canPlayReady = video.readyState >= 2;
              let seekReady = !needsSeek || Math.abs(video.currentTime - targetEntrySec) <= 0.02;
              if (canPlayReady && seekReady) {
                resolve();
                return;
              }

              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('seeked', onSeeked);
                resolve();
              };
              const onCanPlay = () => {
                canPlayReady = true;
                if (seekReady) finish();
              };
              const onSeeked = () => {
                seekReady = true;
                if (canPlayReady || video.readyState >= 2) finish();
              };

              const timer = window.setTimeout(finish, 4000);
              if (!canPlayReady) {
                video.addEventListener('canplay', onCanPlay, { once: true });
              }
              if (!seekReady) {
                video.addEventListener('seeked', onSeeked, { once: true });
              }
            })
        );
        await Promise.all(waitPromises);
      }

      const startTime = audioCtx.currentTime + 0.08;
      for (const seg of segments) {
        const key = `${scene.style}:${seg.beatId}:${seg.media?.audioBase64?.length ?? 0}:${seg.media?.audioBase64?.slice(96, 128) ?? ''}`;
        const buf = decodedBuffersRef.current[key];
        if (!buf) continue;
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        src.start(startTime + seg.startSec);
      }

      recorder.start(250);
      setExportMessage(
        hasAllMovingVideo
          ? 'Rendering 30-second moving video with audio and subtitles...'
          : 'Rendering 30-second slideshow clip with synchronized audio and subtitles...'
      );

      await new Promise<void>((resolve) => {
        const renderStep = () => {
          const elapsed = audioCtx.currentTime - startTime;
          if (elapsed >= totalDurationSec) {
            stopAllVideoElements();
            setExportProgress(100);
            resolve();
            return;
          }
          const tClamped = Math.max(0, elapsed);
          const seg = findSegmentAt(tClamped);
          const beatElapsed = Math.max(0, tClamped - seg.startSec);
          const cue = getActiveSubtitleCue(seg.subtitleCues, beatElapsed);
          const lastCueEndSec =
            seg.subtitleCues.length > 0
              ? seg.subtitleCues[seg.subtitleCues.length - 1].endSec
              : undefined;
          const withinActiveWindow = tClamped > 0.02 && tClamped < totalDurationSec - 0.05;
          const activeVideoElement = syncActiveVideoElement(seg, beatElapsed, true, tClamped);

          renderBeatFrame({
            ctx: eCtx,
            width: 1280,
            height: 720,
            style: scene.style,
            storyboard,
            direction: seg.media.sceneDirection,
            beatId: seg.beatId,
            beatElapsedSec: beatElapsed,
            beatDurationSec: seg.durationSec,
            activeSpeaker: cue?.speaker ?? null,
            isPlayingAudio: Boolean(cue),
            activeVideoElement,
            lastCueEndSec,
            subtitleText: withinActiveWindow && cue ? cue.text : '',
            renderSubtitlesOnCanvas: withinActiveWindow && Boolean(cue),
          });

          setExportProgress(Math.min(99, Math.round((tClamped / totalDurationSec) * 100)));
          requestAnimationFrame(renderStep);
        };
        requestAnimationFrame(renderStep);
      });

      recorder.stop();
      const videoBlob = await donePromise;
      const url = URL.createObjectURL(videoBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'CineLingo-30s-clip.webm';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportMessage('Downloaded CineLingo-30s-clip.webm!');
    } catch (err) {
      console.error('[CineLingo Video Export Error]', err);
      setExportMessage('Video export failed in this browser.');
    } finally {
      stopAllVideoElements();
      setIsExporting(false);
    }
  };

  const currentSegment = findSegmentAt(currentTimeSec);

  return (
    <section className="cinema-enter max-w-5xl mx-auto px-4 sm:px-6 pt-8 pb-32 md:pb-16 overflow-x-hidden">
      <div className="mb-7 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-xs sm:text-sm font-medium tracking-wide text-[#E5C9AD] mb-2">
            {!slideshowFallbackMode && (useMasterVideo || hasAllMovingVideo || hasMatchingPersistedMaster)
              ? 'Now Showing · Moving Video Screening'
              : slideshowFallbackMode && hasAllServerAudio
              ? 'Animated Slideshow Fallback · Synchronized Voices & Subtitles'
              : canUsePreviewSpeech
              ? 'Preview Audio · Browser Speech Fallback (Not Export-Ready)'
              : 'Moving Video Screening'}
          </p>
          <h1 className="font-display text-3xl sm:text-5xl font-bold text-[#F5F0E6] tracking-tight text-balance">
            {storyboard.title}
          </h1>
        </div>

        <button
          type="button"
          onClick={() => {
            if (masterVideoRef.current && !masterVideoRef.current.paused) {
              masterVideoRef.current.pause();
            }
            stopAllAudio();
            onBackToStoryboard();
          }}
          className="liquid-glass-btn-secondary min-h-[44px] px-5 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 self-start sm:self-auto"
        >
          <ArrowLeft className="w-4 h-4 text-[#E5C9AD]" />
          Back to Storyboard
        </button>
      </div>

      {slideshowFallbackMode && (
        <div
          role="status"
          className="liquid-glass-panel mb-6 p-4 sm:p-5 rounded-[20px] text-[#F5F0E6] flex items-start gap-3"
        >
          <AlertCircle className="w-5 h-5 text-[#E5C9AD] shrink-0 mt-0.5" />
          <div className="text-sm text-[#F5F0E6]/85 leading-relaxed space-y-1">
            {hasAllServerAudio ? (
              <p>
                <span className="font-semibold text-[#F5F0E6]">
                  Animated Slideshow Fallback Active:{' '}
                </span>
                Playing finalized storyboard frames with gentle camera motion, full English dialogue audio, and synchronized subtitles. You can return to Studio Production anytime to film or import moving character video.
              </p>
            ) : canUsePreviewSpeech ? (
              <>
                <p>
                  <span className="font-semibold text-[#F5F0E6]">
                    Preview Audio (Browser Speech Synthesis):{' '}
                  </span>
                  {hasAnyServerAudio
                    ? 'Cached Gemini voice audio plays where saved; remaining lines use temporary browser Preview Audio rather than final studio voices. Video export stays disabled until all Gemini voice audio is ready.'
                    : 'Gemini voice audio is not yet cached, so dialogue plays using temporary browser Preview Audio (not final-quality or export-ready audio). Video export stays disabled until Gemini voice audio is generated.'}
                </p>
                {voicesReady && (
                  <p className="text-xs text-[#E5C9AD]">
                    Voices — Emma: {previewVoices.emmaVoiceLabel} · Chloe:{' '}
                    {previewVoices.chloeVoiceLabel}
                  </p>
                )}
              </>
            ) : (
              <p>
                <span className="font-semibold text-[#F5F0E6]">
                  Silent visual preview:{' '}
                </span>
                {speechErrorNotice ||
                  'Neither cached Gemini audio nor browser speech synthesis is available. Playing synchronized visuals and English subtitles silently.'}
              </p>
            )}
          </div>
        </div>
      )}

      {hasTimingConflict && (
        <div className="liquid-glass-panel mb-4 px-4 py-2.5 rounded-2xl text-xs text-[#E5C9AD]">
          Note: Complete spoken dialogue and closing end credit naturally run{' '}
          {totalDurationSec > 31.2 ? `${totalDurationSec.toFixed(1)}s` : 'around 30 seconds'}{' '}
          (preserved in full without cutting off any words).
        </div>
      )}

      <input
        ref={importInputRef}
        type="file"
        accept="video/mp4,.mp4"
        className="hidden"
        onChange={(e) => {
          const selected = e.target.files?.[0];
          e.target.value = '';
          if (selected) {
            handleImportMasterFile(selected);
          }
        }}
      />

      {/* Private Cinema Screening Frame (Frosted Glass Surround) */}
      <div className="liquid-glass-panel rounded-[24px] overflow-hidden p-3 sm:p-4">
        <div
          className="relative w-full bg-black rounded-2xl overflow-hidden select-none"
          style={{ aspectRatio: '16 / 9' }}
        >
          {slideshowFallbackMode ? (
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              onClick={togglePlay}
              className="w-full h-full block object-cover object-center cursor-pointer"
            />
          ) : useMasterVideo && masterMedia ? (
            <video
              ref={masterVideoRef}
              src={showSubtitles ? masterMedia.subtitledUrl : masterMedia.cleanUrl}
              playsInline
              preload="auto"
              onClick={togglePlay}
              onLoadedMetadata={() => {
                setVideoPlaybackError(null);
                const vid = masterVideoRef.current;
                const restore = pendingMasterRestoreRef.current;
                if (vid && restore) {
                  pendingMasterRestoreRef.current = null;
                  vid.currentTime = Math.max(0, Math.min(totalDurationSec, restore.timeSec));
                  if (restore.shouldPlay) {
                    vid.play().catch(() => {});
                  }
                }
              }}
              onError={async () => {
                if (!masterMedia?.isBlobFallback) {
                  const idbRec = await loadMasterFromIndexedDb(scene.style);
                  if (idbRec) {
                    const cleanObjUrl = URL.createObjectURL(idbRec.cleanBlob);
                    const subObjUrl = URL.createObjectURL(idbRec.subtitledBlob);
                    objectUrlsRef.current.push(cleanObjUrl, subObjUrl);
                    setMasterMedia((prev) =>
                      prev
                        ? {
                            ...prev,
                            cleanUrl: cleanObjUrl,
                            subtitledUrl: subObjUrl,
                            isBlobFallback: true,
                          }
                        : {
                            signature: masterSignature || `idb:${scene.style}`,
                            cleanUrl: cleanObjUrl,
                            subtitledUrl: subObjUrl,
                            totalDurationSec: idbRec.info.totalDurationSec || 30,
                            beatStarts: idbRec.info.beatStarts || {},
                            isBlobFallback: true,
                          }
                    );
                    setVideoPlaybackError(null);
                    return;
                  }
                }
                setIsPlaying(false);
                setVideoPlaybackError(
                  'Moving video stream failed to load. Retry loading or import your saved CineLingo MP4 file without regenerating.'
                );
              }}
              onPlay={() => {
                setHasStartedPlayback(true);
                setIsPlaying(true);
              }}
              onPause={() => {
                if (masterVideoRef.current) {
                  setCurrentTimeSec(masterVideoRef.current.currentTime);
                }
                setIsPlaying(false);
              }}
              onSeeked={() => {
                if (masterVideoRef.current && !isPlaying) {
                  setCurrentTimeSec(masterVideoRef.current.currentTime);
                }
              }}
              onEnded={() => {
                setIsPlaying(false);
                setCurrentTimeSec(totalDurationSec);
              }}
              className="w-full h-full block object-cover object-center cursor-pointer"
            />
          ) : shouldUseMasterMode && isAssemblingMaster && !masterError && !videoPlaybackError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#120A0E]/90 text-[#F5F0E6]">
              <Loader2 className="w-9 h-9 animate-spin text-[#E5C9AD]" />
              <p className="text-sm font-medium text-[#F5F0E6]">
                Mastering continuous 30-second video...
              </p>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-[#180D12] text-[#F5F0E6]">
              <AlertCircle className="w-10 h-10 text-[#E5C9AD] mb-3" />
              <h2 className="font-display text-xl sm:text-2xl font-bold text-[#F5F0E6]">
                Moving Video Unavailable Right Now
              </h2>
              <p className="mt-2 max-w-lg text-sm text-[#F5F0E6]/80 leading-relaxed">
                {videoPlaybackError ||
                  masterError ||
                  importError ||
                  'Completed moving-video footage could not be loaded for this scene. Static slideshow fallback was NOT activated automatically.'}
              </p>
              {importError && (
                <p className="mt-2 text-xs text-[#E5C9AD]">{importError}</p>
              )}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={isAssemblingMaster || isImportingMaster}
                  onClick={handleRetryMovingVideo}
                  className="liquid-glass-btn-primary min-h-[44px] px-5 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                >
                  <RefreshCw className="w-4 h-4 text-[#E5C9AD]" />
                  Retry Moving Video
                </button>
                <button
                  type="button"
                  disabled={isImportingMaster}
                  onClick={() => importInputRef.current?.click()}
                  className="liquid-glass-btn-light min-h-[44px] px-5 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                >
                  {isImportingMaster ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-[#722F37]" />
                      Importing MP4...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4 text-[#722F37]" />
                      Import Saved Video (.mp4)
                    </>
                  )}
                </button>
                {onSelectSlideshowFallback && (
                  <button
                    type="button"
                    onClick={onSelectSlideshowFallback}
                    className="liquid-glass-btn-secondary min-h-[44px] px-5 py-2 rounded-full text-sm font-semibold"
                  >
                    Switch to Animated Slideshow
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Tap-to-play frosted center glass control */}
          {(slideshowFallbackMode || useMasterVideo) &&
            !isPlaying &&
            currentTimeSec < 0.1 &&
            !(shouldUseMasterMode && isAssemblingMaster && !useMasterVideo) && (
              <button
                type="button"
                aria-label="Play 30-second video"
                onClick={togglePlay}
                className="absolute inset-0 flex items-center justify-center bg-[#29151E]/25 hover:bg-[#29151E]/35 transition-colors"
              >
                <span className="w-20 h-20 rounded-full bg-[#722F37]/85 backdrop-blur-md border border-[#E5C9AD]/60 text-[#F5F0E6] flex items-center justify-center shadow-xl">
                  <Play className="w-9 h-9 fill-current ml-1" />
                </span>
              </button>
            )}
        </div>

        {/* Theater Glass Controls Bar */}
        <div className="pt-4 px-2 pb-1">
          <div className="mb-3">
            <input
              type="range"
              aria-label="Video timeline"
              min={0}
              max={totalDurationSec}
              step={0.05}
              value={Math.min(currentTimeSec, totalDurationSec)}
              onChange={(e) => jumpToTime(Number(e.target.value))}
              className="w-full accent-[#E5C9AD] cursor-pointer h-2"
            />
            <div className="flex items-center justify-between text-xs font-mono tabular-nums text-[#E5C9AD] mt-1.5">
              <span>{currentTimeSec.toFixed(1)}s</span>
              <span>
                Scene: {currentSegment?.label ?? 'Hook'} ({(currentSegment?.beatIndex ?? 0) + 1}/4)
              </span>
              <span>{totalDurationSec.toFixed(1)}s</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={togglePlay}
                className="liquid-glass-btn-primary min-h-[48px] px-7 py-2.5 rounded-full text-base font-semibold active:scale-[0.98] inline-flex items-center gap-2"
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-5 h-5" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5 fill-current" />
                    {currentTimeSec >= totalDurationSec - 0.15 ? 'Replay' : 'Play'}
                  </>
                )}
              </button>

              <button
                type="button"
                aria-label="Restart from beginning"
                onClick={handleRestartFromBeginning}
                className="liquid-glass-btn-secondary min-h-[48px] min-w-[48px] rounded-full flex items-center justify-center"
              >
                <RotateCcw className="w-5 h-5 text-[#E5C9AD]" />
              </button>

              <button
                type="button"
                onClick={handleToggleSubtitles}
                className={`min-h-[48px] px-5 py-2 rounded-full border text-sm font-semibold inline-flex items-center gap-2 transition-colors ${
                  showSubtitles
                    ? 'bg-[#722F37]/65 border-[#E5C9AD]/60 text-[#F5F0E6]'
                    : 'bg-[#29151E]/55 border-[#E5C9AD]/25 text-[#F5F0E6]/65'
                }`}
              >
                <Captions className="w-4 h-4 text-[#E5C9AD]" />
                Subtitles {showSubtitles ? 'On' : 'Off'}
              </button>
            </div>

            <button
              type="button"
              disabled={isExporting || (!hasAllServerAudio && !(useMasterVideo && masterMedia))}
              title={
                hasAllServerAudio || (useMasterVideo && masterMedia)
                  ? 'Download video with voice audio and burned-in subtitles'
                  : 'Browser Preview Audio cannot be embedded in .webm downloads. Complete Gemini voice audio in Studio Production to export.'
              }
              onClick={handleDownloadVideo}
              className="liquid-glass-btn-light min-h-[48px] px-7 py-2.5 rounded-full text-base font-semibold active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {isExporting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-[#722F37]" />
                  Exporting {exportProgress}%
                </>
              ) : (
                <>
                  <Download className="w-5 h-5 text-[#722F37]" />
                  Download Video
                </>
              )}
            </button>
          </div>

          {exportMessage && (
            <p className="mt-3 text-sm font-medium text-[#E5C9AD]">{exportMessage}</p>
          )}
        </div>
      </div>

      {/* Beat Jump Strip */}
      <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        {segments.map((seg) => {
          const isCurrent = currentSegment?.beatId === seg.beatId;
          return (
            <button
              key={seg.beatId}
              type="button"
              onClick={() => jumpToTime(seg.startSec)}
              className={`min-h-[58px] p-3.5 rounded-[18px] text-left transition-all ${
                isCurrent
                  ? 'liquid-glass-ivory text-[#21191B] ring-1 ring-[#E5C9AD]'
                  : 'liquid-glass-panel text-[#F5F0E6] hover:border-[#E5C9AD]/45'
              }`}
            >
              <div
                className={`text-xs font-mono tabular-nums font-semibold ${
                  isCurrent ? 'text-[#722F37]' : 'text-[#E5C9AD]'
                }`}
              >
                {seg.startSec.toFixed(0)}–{seg.endSec.toFixed(0)}s
              </div>
              <div className="font-display text-base font-bold mt-0.5">
                0{seg.beatIndex + 1}. {seg.label}
              </div>
            </button>
          );
        })}
      </div>

      {/* Playbill: Expressions Practiced */}
      <div className="liquid-glass-ivory mt-8 text-[#21191B] rounded-[22px] p-5 sm:p-6">
        <h2 className="font-display text-xl font-bold text-[#21191B] mb-3 flex items-center gap-2">
          <Film className="w-5 h-5 text-[#722F37]" aria-hidden="true" />
          Featured Lines in This Screening
        </h2>
        <div className="divide-y divide-[#722F37]/12">
          {expressions
            .filter((e) => e.english.trim())
            .map((exp) => (
              <div
                key={exp.id}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-1"
              >
                <span className="font-semibold text-base text-[#21191B]">
                  {exp.english}
                </span>
                <span className="text-sm text-[#21191B]/75">
                  {exp.korean}{' '}
                  <span aria-hidden="true" className="text-[#722F37]/45 mx-1">
                    ·
                  </span>{' '}
                  <span className="font-semibold text-[#722F37]">{exp.movie}</span>
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* Original Credit Text Preserved */}
      <footer className="mt-10 pt-6 border-t border-[#E5C9AD]/20 text-center">
        <p className="font-display text-base font-semibold text-[#F5F0E6]/90">
          Made with Google AI Studio · Script by [Noel Roh]
        </p>
      </footer>
    </section>
  );
};
