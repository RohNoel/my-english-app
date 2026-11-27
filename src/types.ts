export type AppStep = 'expressions' | 'scene' | 'storyboard' | 'video' | 'final';

export type VisualStyleId =
  | 'live_action'
  | '3d_animation'
  | '2d_animation'
  | 'american_comic';

export interface ExpressionEntry {
  id: string;
  english: string;
  korean: string;
  movie: string;
}

export interface CourseExpression {
  id: string;
  english: string;
  korean: string;
  movie: string;
  keywords?: string[];
}

export interface SceneSetup {
  place: string;
  characters: string;
  situation: string;
  style: VisualStyleId;
}

export interface DialogueTurn {
  speaker: string;
  line: string;
}

export interface MatchedExpressionSpan {
  typedExpression: string;
  spokenPhrase: string;
  sourceMovie: string;
}

export interface CharacterProfile {
  name: string;
  role: string;
  skinTone: string;
  hairColor: string;
  hairStyle: 'short_wavy' | 'long_wavy' | 'bob' | 'curly_ponytail' | 'neat_part';
  outfitColor: string;
  outfitAccent: string;
  glasses?: boolean;
  voiceName: 'Kore' | 'Puck' | 'Zephyr' | 'Charon' | 'Fenrir';
}

export type BeatId = 'hook' | 'problem' | 'turn' | 'close';

export interface StoryboardBeat {
  id: BeatId;
  label: string;
  timeRange: string;
  startSec: number;
  endSec: number;
  sceneDescription: string;
  dialogue: DialogueTurn[];
  usedExpressions: MatchedExpressionSpan[];
  visualDirection?: BeatSceneDirection;
}

export interface StoryboardData {
  title: string;
  characters: CharacterProfile[];
  settingPalette: {
    wallColor: string;
    accentColor: string;
    tableColor: string;
    lightingMood: 'warm_daylight' | 'cozy_evening' | 'bright_morning' | 'soft_indoor';
  };
  beats: StoryboardBeat[];
}

export interface BeatSceneDirection {
  style?: VisualStyleId;
  environment: 'cafe' | 'library' | 'dorm' | 'campus_quad' | 'subway' | 'office';
  cameraFraming: 'wide' | 'medium_two_shot' | 'over_shoulder' | 'close_up';
  kenBurns: {
    startScale: number;
    endScale: number;
    startX: number;
    endX: number;
    startY: number;
    endY: number;
  };
  leftCharacterMood: 'neutral' | 'nervous' | 'surprised' | 'happy' | 'laughing' | 'embarrassed' | 'deadpan';
  rightCharacterMood: 'neutral' | 'nervous' | 'surprised' | 'happy' | 'laughing' | 'curious' | 'amused';
  activeProp:
    | 'laptop_slides'
    | 'laptop_cat_party'
    | 'email_alert'
    | 'iced_coffee'
    | 'notebook_pen'
    | 'smartphone'
    | 'none';
  cutToBlackAtEnd?: boolean;
  visualAccentNote: string;
}

export interface SubtitleCue {
  speaker: string;
  text: string;
  startSec: number;
  endSec: number;
}

export interface VideoClipSegment {
  url: string;
  durationSec: number;
  actualDurationSec?: number;
  trimStartSec?: number;
  trimEndSec?: number;
  playbackRate?: number;
  syncVersion?: number;
  label?: string;
}

export interface GeneratedBeatMedia {
  beatId: BeatId;
  styleApplied?: VisualStyleId;
  hasLaughTrack?: boolean;
  hasMovingVideo?: boolean;
  videoClips?: VideoClipSegment[];
  dialogueFingerprint?: string;
  sceneKey?: string;
  sceneDirection: BeatSceneDirection;
  audioBase64: string;
  audioDurationSec: number;
  dialogueAudioBase64?: string;
  dialogueDurationSec?: number;
  targetDurationSec: number;
  subtitleCues: SubtitleCue[];
  status: 'idle' | 'generating' | 'ready' | 'error';
  statusDetail?: string;
  errorMessage?: string;
  errorDiagnostics?: string;
  errorType?: 'rate_limit' | 'daily_quota_exhausted' | 'paid_key_required' | 'auth' | 'server';
  retryAfterSec?: number;
}

export interface PersistedMasterVideoInfo {
  style: VisualStyleId;
  title: string;
  scenePlace: string;
  sceneSituation: string;
  cleanUrl: string;
  subtitledUrl: string;
  totalDurationSec: number;
  beatStarts: Record<string, { startSec: number; endSec: number; durationSec: number }>;
  subtitleCuesByBeat: Record<string, SubtitleCue[]>;
  hasLaughTrackByBeat: Record<string, boolean>;
  imported?: boolean;
  updatedAt: string;
}
