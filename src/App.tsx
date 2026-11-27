import { useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { ExpressionStep } from './components/ExpressionStep';
import { SceneStep } from './components/SceneStep';
import { StoryboardStep } from './components/StoryboardStep';
import { VideoGenStep } from './components/VideoGenStep';
import { FinalPlayerStep } from './components/FinalPlayerStep';
import {
  FIXED_EXPRESSIONS,
  ORIGINAL_STORYBOARD,
  VISUAL_STYLE_DEFINITIONS,
  getLocalBeatDirection,
  isOriginalBeatScriptUnchanged,
} from './data/courseExpressions';
import { preloadStyleAssets } from './engine/sceneRenderer';
import {
  AppStep,
  BeatSceneDirection,
  CourseExpression,
  GeneratedBeatMedia,
  PersistedMasterVideoInfo,
  SceneSetup,
  StoryboardBeat,
  StoryboardData,
  SubtitleCue,
  VisualStyleId,
} from './types';
import {
  listIndexedDbMasters,
  saveMasterToIndexedDb,
} from './utils/videoVault';

interface CachedAudioAsset {
  audioBase64: string;
  audioDurationSec: number;
  subtitleCues: SubtitleCue[];
  hasLaughTrack: boolean;
}

interface PersistedWorkspaceState {
  step: AppStep;
  selectedExpressions: CourseExpression[];
  scene: SceneSetup;
  storyboard: StoryboardData | null;
  explicitSlideshowMode: boolean;
  updatedAt: string;
}

const AUDIO_STORAGE_KEY = 'cinelingo_audio_cache_v1';
const CLIP_STORAGE_KEY = 'cinelingo_clip_cache_v1';
const WORKSPACE_STORAGE_KEY = 'cinelingo_workspace_state_v1';

const DEFAULT_SCENE: SceneSetup = {
  place: 'University café',
  characters: 'Emma & Chloe',
  situation:
    "Emma accidentally emailed her cat's birthday slideshow instead of their academic presentation slides.",
  style: '3d_animation',
};

function loadWorkspaceState(): PersistedWorkspaceState | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceState>;
    if (!parsed || typeof parsed !== 'object' || !parsed.scene) return null;
    const validSteps: AppStep[] = ['expressions', 'scene', 'storyboard', 'video', 'final'];
    const step: AppStep = validSteps.includes(parsed.step as AppStep)
      ? (parsed.step as AppStep)
      : 'expressions';
    return {
      step,
      selectedExpressions: Array.isArray(parsed.selectedExpressions)
        ? parsed.selectedExpressions
        : [],
      scene: {
        place: parsed.scene.place || DEFAULT_SCENE.place,
        characters: parsed.scene.characters || DEFAULT_SCENE.characters,
        situation: parsed.scene.situation || DEFAULT_SCENE.situation,
        style: parsed.scene.style || DEFAULT_SCENE.style,
      },
      storyboard: parsed.storyboard ?? null,
      explicitSlideshowMode: Boolean(parsed.explicitSlideshowMode),
      updatedAt: parsed.updatedAt || '',
    };
  } catch {
    return null;
  }
}

function saveWorkspaceState(state: PersistedWorkspaceState) {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota errors gracefully
  }
}

function loadSessionCache<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function saveSessionCache<T>(key: string, data: Record<string, T>) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Ignore storage quota overflow gracefully; in-memory ref remains active
  }
}

async function safeParseApiResponse(resp: Response): Promise<{
  data: Record<string, unknown>;
  isGatewayHtmlError: boolean;
}> {
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text);
    return {
      data: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
      isGatewayHtmlError: false,
    };
  } catch {
    const trimmed = text.trim();
    const isHtml = /^<!doctype|^<html/i.test(trimmed);
    const titleMatch = trimmed.match(/<title>([^<]+)<\/title>/i);
    const titleHint = titleMatch ? titleMatch[1].trim() : `HTTP ${resp.status}`;
    const err = new Error(
      isHtml
        ? `Server gateway timed out or returned HTML (${titleHint}) instead of JSON.`
        : `Server returned non-JSON response (HTTP ${resp.status}).`
    ) as Error & {
      errorType?: GeneratedBeatMedia['errorType'];
      rawDetail?: string;
      isGatewayHtmlError?: boolean;
    };
    err.errorType = 'server';
    err.rawDetail = `HTTP ${resp.status}: ${trimmed.slice(0, 300)}`;
    err.isGatewayHtmlError = isHtml || resp.status >= 502;
    throw err;
  }
}

function cloneOriginalStoryboard(style: VisualStyleId): StoryboardData {
  const cloned = JSON.parse(JSON.stringify(ORIGINAL_STORYBOARD)) as StoryboardData;
  cloned.beats = cloned.beats.map((b) => ({
    ...b,
    visualDirection: getLocalBeatDirection(b.id, style),
  }));
  return cloned;
}

function getDialogueFingerprint(beat: StoryboardBeat): string {
  return beat.dialogue
    .map((d) => `${d.speaker.trim().toLowerCase()}:${d.line.trim()}`)
    .join('|');
}

function getSceneVisualKey(beat: StoryboardBeat, scene: SceneSetup): string {
  return `${beat.id}|${scene.style}|${scene.place.trim()}|${scene.situation.trim()}|${beat.sceneDescription.trim()}`;
}

function getDialogueCacheKey(beat: StoryboardBeat): string {
  return `${beat.id}|${getDialogueFingerprint(beat)}`;
}

function getLiveLaughAudioCacheKey(beat: StoryboardBeat): string {
  return `${beat.id}|${getDialogueFingerprint(beat)}|live_laugh`;
}

function resolveCachedAudioForStyle(
  beat: StoryboardBeat,
  style: VisualStyleId,
  audioCache: Record<string, CachedAudioAsset>
): CachedAudioAsset | undefined {
  if (style === 'live_action' && beat.id === 'problem') {
    const liveLaugh = audioCache[getLiveLaughAudioCacheKey(beat)];
    if (liveLaugh?.audioBase64) return liveLaugh;
    return undefined;
  }
  const dry = audioCache[getDialogueCacheKey(beat)];
  return dry?.audioBase64 ? dry : undefined;
}

function stripAudioForClipStorage(media: GeneratedBeatMedia): GeneratedBeatMedia {
  return {
    ...media,
    audioBase64: '',
    dialogueAudioBase64: undefined,
  };
}

function buildInitialMediaFromStoryboard(
  board: StoryboardData,
  scene: SceneSetup,
  clipCache: Record<string, GeneratedBeatMedia>,
  audioCache: Record<string, CachedAudioAsset>
): Record<string, GeneratedBeatMedia> {
  const initialMedia: Record<string, GeneratedBeatMedia> = {};
  for (const beat of board.beats) {
    const sceneKey = getSceneVisualKey(beat, scene);
    const dialogueFingerprint = getDialogueFingerprint(beat);
    const cacheId = `${sceneKey}|${dialogueFingerprint}`;
    const cachedClip = clipCache[cacheId];
    const cachedAudio = resolveCachedAudioForStyle(beat, scene.style, audioCache);
    const localOrExistingDir: BeatSceneDirection = isOriginalBeatScriptUnchanged(beat, scene)
      ? getLocalBeatDirection(beat.id, scene.style)
      : beat.visualDirection ?? getLocalBeatDirection(beat.id, scene.style);

    const hasCachedMovingVideo = Boolean(
      cachedClip &&
        cachedClip.status === 'ready' &&
        cachedClip.styleApplied === scene.style &&
        cachedClip.sceneKey === sceneKey &&
        cachedClip.dialogueFingerprint === dialogueFingerprint &&
        cachedClip.hasMovingVideo &&
        Array.isArray(cachedClip.videoClips) &&
        cachedClip.videoClips.length > 0
    );

    if (hasCachedMovingVideo && cachedAudio?.audioBase64) {
      initialMedia[beat.id] = {
        ...cachedClip,
        audioBase64: cachedAudio.audioBase64,
        audioDurationSec: cachedAudio.audioDurationSec,
        subtitleCues: cachedAudio.subtitleCues,
        hasLaughTrack: cachedAudio.hasLaughTrack,
      };
      continue;
    }

    initialMedia[beat.id] = {
      beatId: beat.id,
      styleApplied: undefined,
      hasMovingVideo: false,
      videoClips: [],
      dialogueFingerprint,
      sceneKey,
      sceneDirection: localOrExistingDir,
      audioBase64: cachedAudio?.audioBase64 ?? '',
      audioDurationSec:
        cachedAudio?.audioDurationSec ?? Math.max(4, beat.endSec - beat.startSec),
      targetDurationSec: Math.max(5, beat.endSec - beat.startSec),
      subtitleCues: cachedAudio?.subtitleCues ?? [],
      hasLaughTrack: cachedAudio?.hasLaughTrack ?? false,
      status: 'idle',
    };
  }
  return initialMedia;
}

export default function App() {
  const initialWorkspaceRef = useRef<PersistedWorkspaceState | null | undefined>(undefined);
  if (initialWorkspaceRef.current === undefined) {
    initialWorkspaceRef.current = loadWorkspaceState();
  }
  const initialWorkspace = initialWorkspaceRef.current;

  const [step, setStep] = useState<AppStep>(initialWorkspace?.step ?? 'expressions');
  const [selectedExpressions, setSelectedExpressions] = useState<CourseExpression[]>(
    initialWorkspace?.selectedExpressions ?? []
  );
  const [scene, setScene] = useState<SceneSetup>(initialWorkspace?.scene ?? DEFAULT_SCENE);

  const [storyboard, setStoryboard] = useState<StoryboardData | null>(
    initialWorkspace?.storyboard ?? null
  );
  const [storyboardError, setStoryboardError] = useState<string | null>(null);
  const [regeneratingBeatId, setRegeneratingBeatId] = useState<string | null>(null);

  const audioCacheRef = useRef<Record<string, CachedAudioAsset>>(
    loadSessionCache<CachedAudioAsset>(AUDIO_STORAGE_KEY)
  );
  const clipCacheRef = useRef<Record<string, GeneratedBeatMedia>>(
    loadSessionCache<GeneratedBeatMedia>(CLIP_STORAGE_KEY)
  );

  const [beatMedia, setBeatMedia] = useState<Record<string, GeneratedBeatMedia>>(() =>
    initialWorkspace?.storyboard
      ? buildInitialMediaFromStoryboard(
          initialWorkspace.storyboard,
          initialWorkspace.scene,
          clipCacheRef.current,
          audioCacheRef.current
        )
      : {}
  );
  const [persistedMasters, setPersistedMasters] = useState<
    Record<string, PersistedMasterVideoInfo>
  >({});
  const [isGeneratingAllVideo, setIsGeneratingAllVideo] = useState(false);
  const [isPreparingFallback, setIsPreparingFallback] = useState(false);
  const [isSlideshowFallback, setIsSlideshowFallback] = useState(
    Boolean(initialWorkspace?.explicitSlideshowMode)
  );
  const [isImportingMaster, setIsImportingMaster] = useState(false);
  const [importMasterError, setImportMasterError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const activeStyleRef = useRef<VisualStyleId>(scene.style);
  activeStyleRef.current = scene.style;

  // Persist workspace progress across refreshes, browser closes, and restarts
  useEffect(() => {
    saveWorkspaceState({
      step,
      selectedExpressions,
      scene,
      storyboard,
      explicitSlideshowMode: isSlideshowFallback,
      updatedAt: new Date().toISOString(),
    });
  }, [step, selectedExpressions, scene, storyboard, isSlideshowFallback]);

  useEffect(() => {
    isMountedRef.current = true;
    preloadStyleAssets().catch(() => {});

    // Hydrate saved moving-video masters from persistent server vault & browser IndexedDB on boot
    (async () => {
      try {
        const [serverResp, idbList] = await Promise.all([
          fetch('/api/video/masters')
            .then((r) => (r.ok ? r.json() : { masters: [] }))
            .catch(() => ({ masters: [] })),
          listIndexedDbMasters().catch(() => []),
        ]);

        if (!isMountedRef.current) return;
        const serverMasters: PersistedMasterVideoInfo[] = Array.isArray(serverResp?.masters)
          ? serverResp.masters
          : [];
        const masterMap: Record<string, PersistedMasterVideoInfo> = {};
        for (const m of serverMasters) {
          if (m?.style && m.cleanUrl) {
            masterMap[m.style] = m;
          }
        }

        // If browser IndexedDB holds a saved MP4 missing from server disk, restore it to server automatically
        for (const rec of idbList) {
          if (!masterMap[rec.style] && rec.cleanBlob.size > 4096) {
            try {
              const params = new URLSearchParams({
                style: rec.style,
                title: rec.info.title || 'The Purr-fect Presentation',
                place: rec.info.scenePlace || DEFAULT_SCENE.place,
                situation: rec.info.sceneSituation || DEFAULT_SCENE.situation,
              });
              const uploadResp = await fetch(`/api/video/import-master?${params.toString()}`, {
                method: 'POST',
                headers: { 'Content-Type': 'video/mp4' },
                body: rec.cleanBlob,
              });
              const uploadData = await uploadResp.json().catch(() => ({}));
              if (uploadResp.ok && uploadData?.master) {
                masterMap[rec.style] = uploadData.master as PersistedMasterVideoInfo;
              } else {
                masterMap[rec.style] = rec.info;
              }
            } catch {
              masterMap[rec.style] = rec.info;
            }
          }
        }

        if (!isMountedRef.current) return;
        setPersistedMasters(masterMap);

        if (initialWorkspace?.storyboard) {
          await hydrateCachedVideosFromDisk(initialWorkspace.storyboard, initialWorkspace.scene);
          return;
        }

        // Fresh browser / cleared storage / shared link with existing completed moving video:
        // restore the saved moving-video screening automatically at zero API cost
        const availableMasters = Object.values(masterMap).sort((a, b) =>
          (b.updatedAt || '').localeCompare(a.updatedAt || '')
        );
        if (availableMasters.length > 0) {
          const best = availableMasters[0];
          const restoredScene: SceneSetup = {
            place: best.scenePlace || DEFAULT_SCENE.place,
            characters: 'Emma & Chloe',
            situation: best.sceneSituation || DEFAULT_SCENE.situation,
            style: best.style,
          };
          const restoredBoard = cloneOriginalStoryboard(best.style);
          if (best.title) {
            restoredBoard.title = best.title;
          }
          setSelectedExpressions([...FIXED_EXPRESSIONS]);
          setScene(restoredScene);
          setStoryboard(restoredBoard);
          setBeatMedia(
            buildInitialMediaFromStoryboard(
              restoredBoard,
              restoredScene,
              clipCacheRef.current,
              audioCacheRef.current
            )
          );
          setIsSlideshowFallback(false);
          await hydrateCachedVideosFromDisk(restoredBoard, restoredScene);
          if (isMountedRef.current) {
            setStep('final');
          }
        }
      } catch {
        // Non-fatal boot discovery
      }
    })();

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!storyboard) return;
    if (step !== 'video' && step !== 'final') return;
    const needsSyncRefresh = storyboard.beats.some((b) => {
      const m = beatMedia[b.id];
      return (
        m?.status === 'ready' &&
        m.styleApplied === scene.style &&
        m.hasMovingVideo &&
        Array.isArray(m.videoClips) &&
        m.videoClips.some((c) => c.syncVersion !== 2)
      );
    });
    if (needsSyncRefresh) {
      hydrateCachedVideosFromDisk(storyboard, scene);
    }
  }, [step, storyboard, scene, beatMedia]);

  const allFiveSelected = selectedExpressions.length === FIXED_EXPRESSIONS.length;

  const isBeatMediaValid = (beat: StoryboardBeat, media?: GeneratedBeatMedia): boolean => {
    if (!media || media.status !== 'ready') return false;
    return (
      media.styleApplied === scene.style &&
      media.sceneKey === getSceneVisualKey(beat, scene) &&
      media.dialogueFingerprint === getDialogueFingerprint(beat) &&
      Boolean(media.audioBase64) &&
      Boolean(media.hasMovingVideo && media.videoClips && media.videoClips.length > 0)
    );
  };

  const allBeatsReady = useMemo(() => {
    if (!storyboard) return false;
    return storyboard.beats.every((b) => {
      const m = beatMedia[b.id];
      return (
        m?.status === 'ready' &&
        m.styleApplied === scene.style &&
        m.sceneKey === getSceneVisualKey(b, scene) &&
        m.dialogueFingerprint === getDialogueFingerprint(b) &&
        Boolean(m.audioBase64) &&
        Boolean(m.hasMovingVideo && m.videoClips && m.videoClips.length > 0)
      );
    });
  }, [storyboard, beatMedia, scene]);

  const localVariationRef = useRef<Record<string, number>>({});

  const hydrateCachedVideosFromDisk = async (
    board: StoryboardData,
    targetScene: SceneSetup
  ) => {
    try {
      const resp = await fetch('/api/video/check-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beats: board.beats.map((b) => ({
            id: b.id,
            startSec: b.startSec,
            endSec: b.endSec,
            sceneDescription: b.sceneDescription,
            dialogue: b.dialogue,
          })),
          characters: board.characters,
          scene: targetScene,
          style: targetScene.style,
        }),
      });
      if (!resp.ok) return;
      const parsed = await safeParseApiResponse(resp);
      const completedMaster = parsed.data?.completedMaster as
        | PersistedMasterVideoInfo
        | null
        | undefined;
      if (completedMaster && completedMaster.style) {
        setPersistedMasters((prev) => ({
          ...prev,
          [completedMaster.style]: completedMaster,
        }));
      }
      const cachedByBeat = parsed.data?.cachedByBeat as
        | Record<
            string,
            {
              videoClips?: GeneratedBeatMedia['videoClips'];
              pendingOperation?: { interactionId: string; pendingClipLabel: string } | null;
              cachedAudio?: {
                audioBase64: string;
                audioDurationSec: number;
                dialogueAudioBase64: string;
                dialogueDurationSec: number;
                subtitleCues: SubtitleCue[];
                hasLaughTrack: boolean;
              };
            }
          >
        | undefined;
      if (!cachedByBeat) return;

      for (const beat of board.beats) {
        const entry = cachedByBeat[beat.id];
        if (entry?.pendingOperation && (!entry.videoClips || entry.videoClips.length === 0)) {
          setBeatMedia((prev) => ({
            ...prev,
            [beat.id]: {
              ...(prev[beat.id] || {
                beatId: beat.id,
                audioBase64: '',
                audioDurationSec: Math.max(4, beat.endSec - beat.startSec),
                targetDurationSec: Math.max(5, beat.endSec - beat.startSec),
                subtitleCues: [],
                sceneDirection:
                  beat.visualDirection?.style === targetScene.style
                    ? beat.visualDirection
                    : getLocalBeatDirection(beat.id, targetScene.style),
                status: 'idle',
              }),
              statusDetail: `In-progress operation saved (${entry.pendingOperation?.pendingClipLabel}) — click Resume Filming to recover`,
            },
          }));
          continue;
        }
        if (!entry?.videoClips || entry.videoClips.length === 0) continue;

        let resolvedAudio = resolveCachedAudioForStyle(
          beat,
          targetScene.style,
          audioCacheRef.current
        );
        if (!resolvedAudio?.audioBase64 && entry.cachedAudio?.audioBase64) {
          const dialogueKey = getDialogueCacheKey(beat);
          audioCacheRef.current[dialogueKey] = {
            audioBase64: entry.cachedAudio.dialogueAudioBase64,
            audioDurationSec: entry.cachedAudio.dialogueDurationSec,
            subtitleCues: entry.cachedAudio.subtitleCues,
            hasLaughTrack: false,
          };
          if (entry.cachedAudio.hasLaughTrack) {
            audioCacheRef.current[getLiveLaughAudioCacheKey(beat)] = {
              audioBase64: entry.cachedAudio.audioBase64,
              audioDurationSec: entry.cachedAudio.audioDurationSec,
              subtitleCues: entry.cachedAudio.subtitleCues,
              hasLaughTrack: true,
            };
          }
          saveSessionCache(AUDIO_STORAGE_KEY, audioCacheRef.current);
          resolvedAudio = {
            audioBase64: entry.cachedAudio.audioBase64,
            audioDurationSec: entry.cachedAudio.audioDurationSec,
            subtitleCues: entry.cachedAudio.subtitleCues,
            hasLaughTrack: entry.cachedAudio.hasLaughTrack,
          };
        }
        if (!resolvedAudio?.audioBase64) continue;

        const sceneKey = getSceneVisualKey(beat, targetScene);
        const dialogueFingerprint = getDialogueFingerprint(beat);
        const endPad = beat.id === 'close' ? 1.15 : 0.25;
        const targetDurationSec = Math.max(
          Math.max(4, beat.endSec - beat.startSec),
          Number((resolvedAudio.audioDurationSec + endPad).toFixed(2))
        );
        const direction =
          beat.visualDirection?.style === targetScene.style
            ? beat.visualDirection
            : getLocalBeatDirection(beat.id, targetScene.style);

        const hydrated: GeneratedBeatMedia = {
          beatId: beat.id,
          styleApplied: targetScene.style,
          hasLaughTrack: resolvedAudio.hasLaughTrack,
          hasMovingVideo: true,
          videoClips: entry.videoClips,
          dialogueFingerprint,
          sceneKey,
          sceneDirection: direction,
          audioBase64: resolvedAudio.audioBase64,
          audioDurationSec: resolvedAudio.audioDurationSec,
          targetDurationSec,
          subtitleCues: resolvedAudio.subtitleCues,
          status: 'ready',
        };

        clipCacheRef.current[`${sceneKey}|${dialogueFingerprint}`] =
          stripAudioForClipStorage(hydrated);
        saveSessionCache(CLIP_STORAGE_KEY, clipCacheRef.current);

        setBeatMedia((prev) => ({
          ...prev,
          [beat.id]: hydrated,
        }));
      }
    } catch {
      // Non-fatal if cache check is unavailable
    }
  };

  const handleOpenStoryboard = () => {
    let targetBoard = storyboard;
    if (!targetBoard) {
      const fresh = cloneOriginalStoryboard(scene.style);
      targetBoard = fresh;
      setStoryboard(fresh);
      setBeatMedia(
        buildInitialMediaFromStoryboard(
          fresh,
          scene,
          clipCacheRef.current,
          audioCacheRef.current
        )
      );
    }
    hydrateCachedVideosFromDisk(targetBoard, scene);
    setStoryboardError(null);
    setStep('storyboard');
  };

  const handleResetToOriginalScript = () => {
    const fresh = cloneOriginalStoryboard(scene.style);
    setStoryboard(fresh);
    setBeatMedia(
      buildInitialMediaFromStoryboard(
        fresh,
        scene,
        clipCacheRef.current,
        audioCacheRef.current
      )
    );
    setStoryboardError(null);
  };

  const handleUpdateBeat = (beatId: string, updatedBeat: StoryboardBeat) => {
    if (!storyboard) return;
    const nextBoard: StoryboardData = {
      ...storyboard,
      beats: storyboard.beats.map((b) => (b.id === beatId ? updatedBeat : b)),
    };
    setStoryboard(nextBoard);

    const newSceneKey = getSceneVisualKey(updatedBeat, scene);
    const newDialogueFp = getDialogueFingerprint(updatedBeat);
    const cachedClip = clipCacheRef.current[`${newSceneKey}|${newDialogueFp}`];
    const cachedAudio = resolveCachedAudioForStyle(
      updatedBeat,
      scene.style,
      audioCacheRef.current
    );

    setBeatMedia((prev) => {
      const curr = prev[beatId];
      if (!curr) return prev;
      if (cachedClip && cachedClip.status === 'ready' && cachedAudio?.audioBase64) {
        return {
          ...prev,
          [beatId]: {
            ...cachedClip,
            audioBase64: cachedAudio.audioBase64,
            audioDurationSec: cachedAudio.audioDurationSec,
            subtitleCues: cachedAudio.subtitleCues,
            hasLaughTrack: cachedAudio.hasLaughTrack,
          },
        };
      }
      if (
        curr.sceneKey === newSceneKey &&
        curr.dialogueFingerprint === newDialogueFp &&
        curr.status === 'ready'
      ) {
        return prev;
      }
      return {
        ...prev,
        [beatId]: {
          ...curr,
          status: 'idle',
          styleApplied: undefined,
          audioBase64: '',
          sceneKey: newSceneKey,
          dialogueFingerprint: newDialogueFp,
        },
      };
    });
  };

  const handleRegenerateBeatVisual = async (beatId: string) => {
    if (!storyboard || regeneratingBeatId || inFlightRef.current) return;
    const targetBeat = storyboard.beats.find((b) => b.id === beatId);
    if (!targetBeat) return;

    // Never call Gemini to regenerate visual direction for the unchanged original storyboard
    if (isOriginalBeatScriptUnchanged(targetBeat, scene)) {
      const nextVar = (localVariationRef.current[beatId] ?? 0) + 1;
      localVariationRef.current[beatId] = nextVar;
      const localDirection = getLocalBeatDirection(targetBeat.id, scene.style, nextVar);
      const updatedBeat: StoryboardBeat = {
        ...targetBeat,
        visualDirection: localDirection,
      };
      setStoryboard({
        ...storyboard,
        beats: storyboard.beats.map((b) => (b.id === beatId ? updatedBeat : b)),
      });
      const sceneKey = getSceneVisualKey(updatedBeat, scene);
      const dialogueFp = getDialogueFingerprint(updatedBeat);
      setBeatMedia((prev) => {
        const curr = prev[beatId];
        if (!curr) return prev;
        const refreshed: GeneratedBeatMedia = {
          ...curr,
          sceneDirection: localDirection,
          styleApplied: curr.audioBase64 ? scene.style : undefined,
          sceneKey,
          dialogueFingerprint: dialogueFp,
          status: curr.audioBase64 ? 'ready' : curr.status,
        };
        if (refreshed.status === 'ready') {
          clipCacheRef.current[`${sceneKey}|${dialogueFp}`] =
            stripAudioForClipStorage(refreshed);
          saveSessionCache(CLIP_STORAGE_KEY, clipCacheRef.current);
        }
        return { ...prev, [beatId]: refreshed };
      });
      setStoryboardError(null);
      return;
    }

    setRegeneratingBeatId(beatId);
    setStoryboardError(null);
    try {
      const resp = await fetch('/api/storyboard/regenerate-beat-visual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beat: targetBeat,
          characters: storyboard.characters,
          scene,
          style: scene.style,
          stylePrompt: VISUAL_STYLE_DEFINITIONS[scene.style],
        }),
      });
      const { data } = await safeParseApiResponse(resp);
      if (!resp.ok) {
        throw new Error(
          typeof data.error === 'string' && data.error
            ? data.error
            : 'Failed to regenerate beat visuals.'
        );
      }

      const regeneratedDirection = data.visualDirection as BeatSceneDirection;
      const updatedBeat: StoryboardBeat = {
        ...targetBeat,
        visualDirection: regeneratedDirection,
      };
      setStoryboard({
        ...storyboard,
        beats: storyboard.beats.map((b) => (b.id === beatId ? updatedBeat : b)),
      });

      const sceneKey = getSceneVisualKey(updatedBeat, scene);
      const dialogueFp = getDialogueFingerprint(updatedBeat);

      setBeatMedia((prev) => {
        const curr = prev[beatId];
        if (!curr) return prev;
        // Preserve already-generated valid audio while refreshing sceneDirection
        const refreshed: GeneratedBeatMedia = {
          ...curr,
          sceneDirection: regeneratedDirection,
          styleApplied: curr.audioBase64 ? scene.style : undefined,
          sceneKey,
          dialogueFingerprint: dialogueFp,
          status: curr.audioBase64 ? 'ready' : 'idle',
        };
        if (refreshed.status === 'ready') {
          clipCacheRef.current[`${sceneKey}|${dialogueFp}`] =
            stripAudioForClipStorage(refreshed);
          saveSessionCache(CLIP_STORAGE_KEY, clipCacheRef.current);
        }
        return { ...prev, [beatId]: refreshed };
      });
    } catch (err) {
      setStoryboardError(
        err instanceof Error ? err.message : 'Failed to regenerate beat visuals.'
      );
    } finally {
      setRegeneratingBeatId(null);
    }
  };

  const generateSingleBeatMedia = async (
    beat: StoryboardBeat,
    board: StoryboardData,
    audioOnly = false
  ): Promise<{ ok: boolean; errorType?: string }> => {
    const requestStyle = scene.style;
    const sceneKey = getSceneVisualKey(beat, scene);
    const dialogueFingerprint = getDialogueFingerprint(beat);
    const dialogueKey = getDialogueCacheKey(beat);
    const existingDialogue = audioCacheRef.current[dialogueKey];

    // Attach local style direction for unchanged original beats so server skips gemini-4-hydrogen
    const beatForGeneration: StoryboardBeat = isOriginalBeatScriptUnchanged(beat, scene)
      ? {
          ...beat,
          visualDirection:
            beat.visualDirection?.style === scene.style
              ? beat.visualDirection
              : getLocalBeatDirection(beat.id, scene.style),
        }
      : beat;

    // Fast path for audioOnly fallback when audio is already cached locally
    const readyAudioForStyle = resolveCachedAudioForStyle(
      beatForGeneration,
      scene.style,
      audioCacheRef.current
    );
    if (
      audioOnly &&
      readyAudioForStyle?.audioBase64 &&
      beatForGeneration.visualDirection?.style === scene.style
    ) {
      const endPad = beat.id === 'close' ? 1.15 : 0.25;
      const targetDurationSec = Math.max(
        Math.max(4, beat.endSec - beat.startSec),
        Number((readyAudioForStyle.audioDurationSec + endPad).toFixed(2))
      );
      setBeatMedia((prev) => ({
        ...prev,
        [beat.id]: {
          beatId: beat.id,
          styleApplied: scene.style,
          hasLaughTrack: readyAudioForStyle.hasLaughTrack,
          hasMovingVideo: prev[beat.id]?.hasMovingVideo ?? false,
          videoClips: prev[beat.id]?.videoClips ?? [],
          dialogueFingerprint,
          sceneKey,
          sceneDirection: beatForGeneration.visualDirection!,
          audioBase64: readyAudioForStyle.audioBase64,
          audioDurationSec: readyAudioForStyle.audioDurationSec,
          targetDurationSec,
          subtitleCues: readyAudioForStyle.subtitleCues,
          status: prev[beat.id]?.hasMovingVideo ? 'ready' : prev[beat.id]?.status || 'idle',
        },
      }));
      return { ok: true };
    }

    if (!audioOnly) {
      setBeatMedia((prev) => ({
        ...prev,
        [beat.id]: {
          ...(prev[beat.id] || {
            beatId: beat.id,
            audioBase64: '',
            audioDurationSec: Math.max(4, beat.endSec - beat.startSec),
            targetDurationSec: Math.max(5, beat.endSec - beat.startSec),
            subtitleCues: [],
            sceneDirection:
              beatForGeneration.visualDirection ??
              getLocalBeatDirection(beat.id, scene.style),
          }),
          styleApplied: undefined,
          hasMovingVideo: false,
          videoClips: [],
          sceneKey,
          dialogueFingerprint,
          status: 'generating',
          statusDetail: 'Preparing voice & starting moving video...',
          errorMessage: undefined,
          errorDiagnostics: undefined,
          errorType: undefined,
          retryAfterSec: undefined,
        },
      }));
    }

    try {
      const resp = await fetch('/api/video/generate-beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beat: beatForGeneration,
          characters: board.characters,
          scene,
          style: scene.style,
          stylePrompt: VISUAL_STYLE_DEFINITIONS[scene.style],
          audioOnly,
          existingDialogueAudio: existingDialogue
            ? {
                audioBase64: existingDialogue.audioBase64,
                audioDurationSec: existingDialogue.audioDurationSec,
                subtitleCues: existingDialogue.subtitleCues,
              }
            : undefined,
        }),
      });
      const { data } = await safeParseApiResponse(resp);
      if (!resp.ok) {
        if (data.rawDetail) {
          console.error(`[CineLingo Production Error @ ${beat.id}]`, data.rawDetail);
        }
        const err = new Error(
          typeof data.error === 'string' && data.error
            ? data.error
            : 'Unable to complete scene generation right now. Please try again.'
        ) as Error & {
          errorType?: GeneratedBeatMedia['errorType'];
          retryAfterSec?: number;
          rawDetail?: string;
        };
        err.errorType = data.errorType as GeneratedBeatMedia['errorType'];
        err.retryAfterSec =
          typeof data.retryAfterSec === 'number' ? data.retryAfterSec : undefined;
        err.rawDetail = typeof data.rawDetail === 'string' ? data.rawDetail : undefined;
        throw err;
      }

      const subtitleCues = (data.subtitleCues as SubtitleCue[]) ?? [];
      const audioBase64 = String(data.audioBase64 ?? '');
      const audioDurationSec = Number(data.audioDurationSec ?? 0);
      const dialogueAudioBase64 =
        typeof data.dialogueAudioBase64 === 'string' ? data.dialogueAudioBase64 : '';
      const dialogueDurationSec =
        typeof data.dialogueDurationSec === 'number'
          ? data.dialogueDurationSec
          : audioDurationSec;
      const hasLaughTrack = Boolean(data.hasLaughTrack);

      // Always store universal dry character dialogue audio across ALL 4 visual styles
      if (dialogueAudioBase64) {
        audioCacheRef.current[dialogueKey] = {
          audioBase64: dialogueAudioBase64,
          audioDurationSec: dialogueDurationSec,
          subtitleCues,
          hasLaughTrack: false,
        };
      }
      // If Live-action Beat 2 mixed in the sitcom audience laugh, cache the mixed WAV separately
      if (hasLaughTrack && audioBase64) {
        audioCacheRef.current[getLiveLaughAudioCacheKey(beat)] = {
          audioBase64,
          audioDurationSec,
          subtitleCues,
          hasLaughTrack: true,
        };
      }
      saveSessionCache(AUDIO_STORAGE_KEY, audioCacheRef.current);

      let finalVideoClips =
        (data.videoClips as GeneratedBeatMedia['videoClips']) ?? [];
      let hasMoving = Boolean(
        data.hasMovingVideo && Array.isArray(finalVideoClips) && finalVideoClips.length > 0
      );
      let videoStatus = String(data.videoStatus ?? (hasMoving ? 'ready' : 'idle'));

      // Poll non-blocking background operation every 5s until ready or error (zero duplicate creations)
      if (!audioOnly && videoStatus === 'pending') {
        const initialClipLabel =
          typeof data.pendingClipLabel === 'string' ? data.pendingClipLabel : beat.label;
        const initialTotal = typeof data.totalClips === 'number' ? data.totalClips : 1;
        const initialCompleted =
          typeof data.completedClips === 'number' ? data.completedClips : 0;

        setBeatMedia((prev) => ({
          ...prev,
          [beat.id]: {
            ...prev[beat.id],
            audioBase64,
            audioDurationSec,
            dialogueAudioBase64,
            dialogueDurationSec,
            targetDurationSec: Number(data.targetDurationSec ?? 7),
            subtitleCues,
            hasLaughTrack,
            sceneDirection: data.sceneDirection as BeatSceneDirection,
            status: 'generating',
            statusDetail:
              initialTotal > 1
                ? `Filming ${initialClipLabel} (${initialCompleted + 1}/${initialTotal})...`
                : `Filming ${initialClipLabel}...`,
          },
        }));

        const maxPolls = 180; // up to 15 minutes
        let transportBlips = 0;

        for (let attempt = 0; attempt < maxPolls; attempt++) {
          await new Promise((r) => setTimeout(r, 5000));
          if (!isMountedRef.current || activeStyleRef.current !== requestStyle) {
            return { ok: false };
          }

          try {
            const pollResp = await fetch('/api/video/poll-beat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                beat: beatForGeneration,
                scene,
                style: requestStyle,
                subtitleCues,
                targetDurationSec: Number(data.targetDurationSec ?? 7),
              }),
            });

            if (!isMountedRef.current || activeStyleRef.current !== requestStyle) {
              return { ok: false };
            }
            const { data: pollData } = await safeParseApiResponse(pollResp);
            transportBlips = 0;

            if (!pollResp.ok) {
              if (pollData.rawDetail) {
                console.error(`[CineLingo Poll Error @ ${beat.id}]`, pollData.rawDetail);
              }
              const err = new Error(
                typeof pollData.error === 'string' && pollData.error
                  ? pollData.error
                  : 'Moving-video generation failed while polling.'
              ) as Error & {
                errorType?: GeneratedBeatMedia['errorType'];
                retryAfterSec?: number;
                rawDetail?: string;
              };
              err.errorType = pollData.errorType as GeneratedBeatMedia['errorType'];
              err.retryAfterSec =
                typeof pollData.retryAfterSec === 'number'
                  ? pollData.retryAfterSec
                  : undefined;
              err.rawDetail =
                typeof pollData.rawDetail === 'string' ? pollData.rawDetail : undefined;
              throw err;
            }

            const pollStatus = String(pollData.videoStatus ?? 'pending');
            if (pollStatus === 'ready') {
              finalVideoClips =
                (pollData.videoClips as GeneratedBeatMedia['videoClips']) ?? [];
              hasMoving = Boolean(
                pollData.hasMovingVideo &&
                  Array.isArray(finalVideoClips) &&
                  finalVideoClips.length > 0
              );
              videoStatus = 'ready';
              break;
            }

            const clipLabel =
              typeof pollData.pendingClipLabel === 'string'
                ? pollData.pendingClipLabel
                : beat.label;
            const totalClips =
              typeof pollData.totalClips === 'number' ? pollData.totalClips : initialTotal;
            const completedClips =
              typeof pollData.completedClips === 'number'
                ? pollData.completedClips
                : initialCompleted;

            setBeatMedia((prev) => ({
              ...prev,
              [beat.id]: {
                ...prev[beat.id],
                status: 'generating',
                statusDetail:
                  totalClips > 1
                    ? `Filming ${clipLabel} (${completedClips + 1}/${totalClips})...`
                    : `Filming ${clipLabel}...`,
              },
            }));
          } catch (pollErr) {
            const pollTyped = pollErr as Error & {
              errorType?: GeneratedBeatMedia['errorType'];
              isGatewayHtmlError?: boolean;
            };
            // Only tolerate brief transport/proxy gateway blips during read-only status polls;
            // never swallow or retry real Gemini API / quota / generation errors.
            const isTransientTransport =
              pollTyped.isGatewayHtmlError ||
              (pollErr instanceof TypeError && !pollTyped.errorType);
            if (isTransientTransport && transportBlips < 3) {
              transportBlips += 1;
              continue;
            }
            throw pollErr;
          }
        }

        if (videoStatus !== 'ready') {
          throw new Error(
            'Moving-video generation is still pending after 15 minutes. Click Retry Scene later to check completion without recreating the clip.'
          );
        }
      }

      const readyMedia: GeneratedBeatMedia = {
        beatId: beat.id,
        styleApplied: (data.styleApplied as VisualStyleId) ?? scene.style,
        hasLaughTrack,
        hasMovingVideo: hasMoving,
        videoClips: finalVideoClips,
        dialogueFingerprint,
        sceneKey,
        sceneDirection: data.sceneDirection as BeatSceneDirection,
        audioBase64,
        audioDurationSec,
        targetDurationSec: Number(data.targetDurationSec ?? 7),
        subtitleCues,
        status: hasMoving ? 'ready' : 'idle',
        statusDetail: undefined,
      };

      if (!isMountedRef.current || activeStyleRef.current !== requestStyle) {
        return { ok: false };
      }

      if (hasMoving) {
        clipCacheRef.current[`${sceneKey}|${dialogueFingerprint}`] =
          stripAudioForClipStorage(readyMedia);
        saveSessionCache(CLIP_STORAGE_KEY, clipCacheRef.current);
      }

      setBeatMedia((prev) => ({
        ...prev,
        [beat.id]: readyMedia,
      }));
      return { ok: true };
    } catch (err) {
      if (!isMountedRef.current || activeStyleRef.current !== requestStyle) {
        return { ok: false };
      }
      const typed = err as Error & {
        errorType?: GeneratedBeatMedia['errorType'];
        retryAfterSec?: number;
        rawDetail?: string;
      };
      if (!audioOnly) {
        setBeatMedia((prev) => ({
          ...prev,
          [beat.id]: {
            ...prev[beat.id],
            styleApplied: undefined,
            hasMovingVideo: false,
            videoClips: [],
            status: 'error',
            statusDetail: undefined,
            errorMessage:
              typed instanceof Error
                ? typed.message
                : 'Unable to complete scene generation right now.',
            errorDiagnostics: typed?.rawDetail,
            errorType: typed?.errorType ?? 'server',
            retryAfterSec: typed?.retryAfterSec,
          },
        }));
      }
      return { ok: false, errorType: typed?.errorType };
    }
  };

  const handleGenerateAllVideo = async () => {
    if (!storyboard || inFlightRef.current) return;
    inFlightRef.current = true;
    setIsGeneratingAllVideo(true);

    try {
      const pendingBeats = storyboard.beats.filter(
        (b) => !isBeatMediaValid(b, beatMedia[b.id])
      );

      for (let i = 0; i < pendingBeats.length; i++) {
        const beat = pendingBeats[i];
        if (i > 0) {
          // Gentle pacing between sequential beat requests to respect RPM quotas
          await new Promise((r) => setTimeout(r, 650));
        }

        const result = await generateSingleBeatMedia(beat, storyboard, false);
        if (!result.ok) {
          // Stop batch cleanly on failure so completed beats stay saved and user can resume or choose fallback
          break;
        }
      }
    } finally {
      inFlightRef.current = false;
      setIsGeneratingAllVideo(false);
    }
  };

  const handleRetryBeat = async (beatId: string) => {
    if (!storyboard || inFlightRef.current) return;
    const beat = storyboard.beats.find((b) => b.id === beatId);
    if (!beat) return;

    inFlightRef.current = true;
    setIsGeneratingAllVideo(true);
    try {
      await generateSingleBeatMedia(beat, storyboard, false);
    } finally {
      inFlightRef.current = false;
      setIsGeneratingAllVideo(false);
    }
  };

  const handleActivateSlideshowFallback = async () => {
    if (!storyboard || inFlightRef.current) return;
    inFlightRef.current = true;
    setIsPreparingFallback(true);
    try {
      // Ensure English dialogue audio (+ Live-action Beat 2 laugh track) is ready for all beats
      for (const beat of storyboard.beats) {
        const current = beatMedia[beat.id];
        const needsAudio =
          !current?.audioBase64 ||
          (scene.style === 'live_action' &&
            beat.id === 'problem' &&
            !current?.hasLaughTrack);
        if (needsAudio) {
          await generateSingleBeatMedia(beat, storyboard, true);
        }
      }
      setIsSlideshowFallback(true);
      setStep('final');
    } finally {
      inFlightRef.current = false;
      setIsPreparingFallback(false);
    }
  };

  const handleImportMasterVideo = async (file: File) => {
    if (isImportingMaster || !storyboard) return;
    setIsImportingMaster(true);
    setImportMasterError(null);
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
        throw new Error(data?.error || 'Could not import the selected MP4 file.');
      }
      const imported = data.master as PersistedMasterVideoInfo;
      await saveMasterToIndexedDb({
        style: scene.style,
        info: imported,
        cleanBlob: file,
        subtitledBlob: file,
      });
      setPersistedMasters((prev) => ({
        ...prev,
        [imported.style]: imported,
      }));
      setIsSlideshowFallback(false);
      await hydrateCachedVideosFromDisk(storyboard, scene);
      setStep('final');
    } catch (err) {
      setImportMasterError(
        err instanceof Error ? err.message : 'Unable to import the selected MP4 file.'
      );
    } finally {
      setIsImportingMaster(false);
    }
  };

  const handlePrimaryTopBarAction = () => {
    if (step === 'expressions') {
      if (allFiveSelected) setStep('scene');
    } else if (step === 'scene') {
      handleOpenStoryboard();
    } else if (step === 'storyboard') {
      // Never auto-regenerate on screen navigation
      setStep('video');
    } else if (step === 'video') {
      if (allBeatsReady || activePersistedMaster) {
        setIsSlideshowFallback(false);
        setStep('final');
      }
    } else {
      setStep('expressions');
    }
  };

  const activePersistedMaster = persistedMasters[scene.style] ?? null;
  const anySavedMaster = useMemo(() => {
    const list = Object.values(persistedMasters);
    if (list.length === 0) return null;
    return (
      list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0] ?? null
    );
  }, [persistedMasters]);

  const handleOpenSavedMasterScreening = async (master: PersistedMasterVideoInfo) => {
    const targetScene: SceneSetup = {
      place: master.scenePlace || scene.place || DEFAULT_SCENE.place,
      characters: scene.characters || 'Emma & Chloe',
      situation: master.sceneSituation || scene.situation || DEFAULT_SCENE.situation,
      style: master.style,
    };
    const targetBoard =
      storyboard && scene.style === master.style
        ? storyboard
        : cloneOriginalStoryboard(master.style);
    if (master.title) targetBoard.title = master.title;
    if (!allFiveSelected) {
      setSelectedExpressions([...FIXED_EXPRESSIONS]);
    }
    setScene(targetScene);
    setStoryboard(targetBoard);
    setBeatMedia(
      buildInitialMediaFromStoryboard(
        targetBoard,
        targetScene,
        clipCacheRef.current,
        audioCacheRef.current
      )
    );
    setIsSlideshowFallback(false);
    await hydrateCachedVideosFromDisk(targetBoard, targetScene);
    setStep('final');
  };

  const primaryActionLabel =
    step === 'expressions'
      ? 'Set the Scene'
      : step === 'scene'
      ? 'Storyboard'
      : step === 'storyboard'
      ? 'Studio Production'
      : step === 'video'
      ? 'Now Showing'
      : 'Choose Lines';

  const primaryActionDisabled =
    (step === 'expressions' && !allFiveSelected) ||
    (step === 'video' && !allBeatsReady && !activePersistedMaster);

  return (
    <div className="min-h-screen cinelingo-canvas-bg text-[#F5F0E6]">
      <TopBar
        currentStep={step}
        onSelectStep={(target) => {
          if (target === 'scene' && !allFiveSelected) return;
          if (target === 'final' && (allBeatsReady || activePersistedMaster)) {
            setIsSlideshowFallback(false);
          }
          // Screen navigation never clears or auto-regenerates existing valid assets
          setStep(target);
        }}
        canAccessScene={allFiveSelected}
        canAccessStoryboard={Boolean(storyboard) && allFiveSelected}
        canAccessVideo={Boolean(storyboard) && allFiveSelected}
        canAccessFinal={
          (allBeatsReady || Boolean(activePersistedMaster) || isSlideshowFallback) &&
          allFiveSelected
        }
        onPrimaryAction={handlePrimaryTopBarAction}
        primaryActionLabel={primaryActionLabel}
        primaryActionDisabled={primaryActionDisabled}
      />

      {step !== 'final' && anySavedMaster && (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-4">
          <div className="liquid-glass-panel rounded-2xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm">
            <span className="text-[#F5F0E6]/90">
              <span className="font-semibold text-[#E5C9AD]">Saved Moving Video Ready:</span>{' '}
              {anySavedMaster.title} (
              {anySavedMaster.style === 'live_action'
                ? 'Live-action'
                : anySavedMaster.style.replace('_', ' ')}
              )
            </span>
            <button
              type="button"
              onClick={() => handleOpenSavedMasterScreening(anySavedMaster)}
              className="liquid-glass-btn-primary min-h-[36px] px-4 py-1.5 rounded-full text-xs sm:text-sm font-semibold"
            >
              Watch Moving Video
            </button>
          </div>
        </div>
      )}

      <main>
        {step === 'expressions' && (
          <ExpressionStep
            selectedExpressions={selectedExpressions}
            onChange={setSelectedExpressions}
            onNext={() => {
              if (allFiveSelected) setStep('scene');
            }}
          />
        )}

        {step === 'scene' && (
          <SceneStep
            scene={scene}
            onChange={(next) => {
              const styleChanged = next.style !== scene.style;
              const sceneTextChanged =
                next.place !== scene.place || next.situation !== scene.situation;

              if ((styleChanged || sceneTextChanged) && storyboard) {
                const updatedBoard: StoryboardData = {
                  ...storyboard,
                  beats: storyboard.beats.map((b) => {
                    if (isOriginalBeatScriptUnchanged(b, next)) {
                      return {
                        ...b,
                        visualDirection: getLocalBeatDirection(b.id, next.style),
                      };
                    }
                    return {
                      ...b,
                      visualDirection:
                        b.visualDirection?.style === next.style && !sceneTextChanged
                          ? b.visualDirection
                          : b.visualDirection
                          ? { ...b.visualDirection, style: undefined }
                          : undefined,
                    };
                  }),
                };
                setStoryboard(updatedBoard);
                setBeatMedia(
                  buildInitialMediaFromStoryboard(
                    updatedBoard,
                    next,
                    clipCacheRef.current,
                    audioCacheRef.current
                  )
                );
                hydrateCachedVideosFromDisk(updatedBoard, next);
              }
              setScene(next);
            }}
            onBack={() => setStep('expressions')}
            onContinueToStoryboard={handleOpenStoryboard}
          />
        )}

        {step === 'storyboard' && storyboard && (
          <StoryboardStep
            storyboard={storyboard}
            style={scene.style}
            onUpdateBeat={handleUpdateBeat}
            onRegenerateBeatVisual={handleRegenerateBeatVisual}
            onResetToOriginal={handleResetToOriginalScript}
            regeneratingBeatId={regeneratingBeatId}
            errorMessage={storyboardError}
            onBack={() => setStep('scene')}
            onProceedToVideo={() => {
              // Navigate without automatically triggering duplicate generation
              hydrateCachedVideosFromDisk(storyboard, scene);
              setStep('video');
            }}
          />
        )}

        {step === 'video' && storyboard && (
          <VideoGenStep
            storyboard={storyboard}
            scene={scene}
            beatMedia={beatMedia}
            isGeneratingAll={isGeneratingAllVideo}
            isPreparingFallback={isPreparingFallback}
            isImportingMaster={isImportingMaster}
            importMasterError={importMasterError}
            onGenerateAll={() => {
              setIsSlideshowFallback(false);
              handleGenerateAllVideo();
            }}
            onRetryBeat={(beatId) => {
              setIsSlideshowFallback(false);
              handleRetryBeat(beatId);
            }}
            onImportMasterVideo={handleImportMasterVideo}
            onBack={() => setStep('storyboard')}
            onWatchFinal={() => {
              setIsSlideshowFallback(false);
              setStep('final');
            }}
            onWatchSlideshowFallback={handleActivateSlideshowFallback}
          />
        )}

        {step === 'final' && storyboard && (
          <FinalPlayerStep
            storyboard={storyboard}
            scene={scene}
            expressions={selectedExpressions}
            beatMedia={beatMedia}
            slideshowFallbackMode={isSlideshowFallback}
            persistedMaster={activePersistedMaster}
            onMasterReady={(master) => {
              setPersistedMasters((prev) => ({
                ...prev,
                [master.style]: master,
              }));
            }}
            onSelectSlideshowFallback={handleActivateSlideshowFallback}
            onBackToStoryboard={() => setStep('storyboard')}
          />
        )}
      </main>
    </div>
  );
}
