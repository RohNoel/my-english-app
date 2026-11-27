import {
  BeatId,
  BeatSceneDirection,
  CourseExpression,
  SceneSetup,
  StoryboardBeat,
  StoryboardData,
  VisualStyleId,
} from '../types';
import { UPDATED_STYLE_BRIEFS } from './visualRegenerationSpec';

export interface VisualStyleOption {
  id: VisualStyleId;
  title: string;
  subtitle: string;
  description: string;
  imageUrl: string;
}

export const VISUAL_STYLE_OPTIONS: VisualStyleOption[] = [
  {
    id: 'live_action',
    title: 'Live-action',
    subtitle: 'Bright teen sitcom look',
    description:
      'Bright Disney Channel / Nickelodeon-era studio lighting, neutral-cool balance, restrained acting.',
    imageUrl: '/src/assets/images/live_hook_v4_1795683336850.jpg',
  },
  {
    id: '3d_animation',
    title: '3D Animation',
    subtitle: 'Youthful & clean 3D',
    description:
      'Neutral-to-warm clean 3D palette, expressive large animated eyes, youthful college students.',
    imageUrl: '/src/assets/images/anim3d_hook_v3_1795681837924.jpg',
  },
  {
    id: '2d_animation',
    title: '2D Animation',
    subtitle: 'Classic American TV cartoon',
    description:
      'Bold outlines, simplified appealing shapes, flat lively cel colors, consistent props.',
    imageUrl: '/src/assets/images/anim2d_hook_v3_1795681839874.jpg',
  },
  {
    id: 'american_comic',
    title: 'American Comic Book',
    subtitle: 'Clean graphic-novel tone',
    description:
      'Crisp ink outlines, halftone contrast, clean paper tones without heavy yellow tint.',
    imageUrl: '/src/assets/images/comic_hook_v3_1795681839482.jpg',
  },
];

export const VISUAL_STYLE_DEFINITIONS: Record<VisualStyleId, string> = {
  ...UPDATED_STYLE_BRIEFS,
};

// Fixed expression database: strictly the 5 required expressions only.
export const FIXED_EXPRESSIONS: CourseExpression[] = [
  {
    id: 'exp-1',
    english: 'You look nervous.',
    korean: '긴장해 보여.',
    movie: 'Minari',
  },
  {
    id: 'exp-2',
    english: 'I was going to + verb',
    korean: '~하려고 했었다.',
    movie: 'Notting Hill',
  },
  {
    id: 'exp-3',
    english: "I'm mortified.",
    korean: '쥐구멍에라도 숨고 싶을 만큼 창피해.',
    movie: 'Inside Out 2',
  },
  {
    id: 'exp-4',
    english: 'Let me + verb',
    korean: '내가 ~할게.',
    movie: 'Notting Hill',
  },
  {
    id: 'exp-5',
    english: 'That made my whole day.',
    korean: '그 덕분에 하루 종일 기분 좋았어.',
    movie: 'Inside Out 2',
  },
];

export const ORIGINAL_STORYBOARD: StoryboardData = {
  title: 'The Purr-fect Presentation',
  characters: [
    {
      name: 'Emma',
      role: 'College student',
      skinTone: '#F4CEB2',
      hairColor: '#3B2314',
      hairStyle: 'long_wavy',
      outfitColor: '#D99B26',
      outfitAccent: '#FEF3C7',
      glasses: false,
      voiceName: 'Kore',
    },
    {
      name: 'Chloe',
      role: 'College friend',
      skinTone: '#F9DEC9',
      hairColor: '#E6C27A',
      hairStyle: 'long_wavy',
      outfitColor: '#3D7A74',
      outfitAccent: '#CCFBF1',
      glasses: false,
      voiceName: 'Zephyr',
    },
  ],
  settingPalette: {
    wallColor: '#F4EFE6',
    accentColor: '#0F766E',
    tableColor: '#B8895C',
    lightingMood: 'warm_daylight',
  },
  beats: [
    {
      id: 'hook',
      label: 'Hook',
      timeRange: '0–7 seconds',
      startSec: 0,
      endSec: 7,
      sceneDescription:
        'At a university café, Emma nervously stares at her laptop. Chloe notices her expression and slowly puts down her iced coffee. Emma avoids eye contact.',
      dialogue: [
        {
          speaker: 'Chloe',
          line: 'You look nervous. Did you email our slides?',
        },
        {
          speaker: 'Emma',
          line: "Not exactly. Please don't freak out.",
        },
      ],
      usedExpressions: [
        {
          typedExpression: 'You look nervous.',
          spokenPhrase: 'You look nervous.',
          sourceMovie: 'Minari',
        },
      ],
      visualDirection: {
        environment: 'cafe',
        cameraFraming: 'medium_two_shot',
        kenBurns: {
          startScale: 1.0,
          endScale: 1.07,
          startX: -12,
          endX: 8,
          startY: 0,
          endY: -4,
        },
        leftCharacterMood: 'nervous',
        rightCharacterMood: 'curious',
        activeProp: 'laptop_slides',
        cutToBlackAtEnd: false,
        visualAccentNote: 'Café two-shot, nervous laptop glance',
      },
    },
    {
      id: 'problem',
      label: 'Problem',
      timeRange: '7–15 seconds',
      startSec: 7,
      endSec: 15,
      sceneDescription:
        'Emma slowly turns her laptop toward Chloe. The screen displays a colorful birthday slideshow featuring a cat wearing a tiny party hat instead of their academic presentation.',
      dialogue: [
        {
          speaker: 'Emma',
          line: "I was going to send our professor the slides, but I sent my cat's birthday slideshow instead. I'm mortified.",
        },
      ],
      usedExpressions: [
        {
          typedExpression: 'I was going to + verb',
          spokenPhrase: 'I was going to send',
          sourceMovie: 'Notting Hill',
        },
        {
          typedExpression: "I'm mortified.",
          spokenPhrase: "I'm mortified.",
          sourceMovie: 'Inside Out 2',
        },
      ],
      visualDirection: {
        environment: 'cafe',
        cameraFraming: 'close_up',
        kenBurns: {
          startScale: 1.02,
          endScale: 1.1,
          startX: 10,
          endX: -8,
          startY: 4,
          endY: -4,
        },
        leftCharacterMood: 'embarrassed',
        rightCharacterMood: 'surprised',
        activeProp: 'laptop_cat_party',
        cutToBlackAtEnd: false,
        visualAccentNote: 'Cat birthday hat slideshow reveal',
      },
    },
    {
      id: 'turn',
      label: 'Turn',
      timeRange: '15–23 seconds',
      startSec: 15,
      endSec: 23,
      sceneDescription:
        "Chloe leans toward the laptop. Suddenly, an email notification pops up. She reads the professor's response, raises her eyebrows, and tries not to laugh.",
      dialogue: [
        {
          speaker: 'Chloe',
          line: 'Let me see. Wait, he replied! He says your cat gets extra credit for excellent visual aids.',
        },
      ],
      usedExpressions: [
        {
          typedExpression: 'Let me + verb',
          spokenPhrase: 'Let me see',
          sourceMovie: 'Notting Hill',
        },
      ],
      visualDirection: {
        environment: 'cafe',
        cameraFraming: 'medium_two_shot',
        kenBurns: {
          startScale: 1.04,
          endScale: 1.11,
          startX: 16,
          endX: 0,
          startY: -4,
          endY: 2,
        },
        leftCharacterMood: 'nervous',
        rightCharacterMood: 'amused',
        activeProp: 'email_alert',
        cutToBlackAtEnd: false,
        visualAccentNote: 'Email pop-up reaction',
      },
    },
    {
      id: 'close',
      label: 'Close',
      timeRange: '23–30 seconds',
      startSec: 23,
      endSec: 30,
      sceneDescription:
        'Emma looks at the photo of her cat on the laptop, takes a sip of her coffee, and delivers her final line with a completely straight face. Chloe bursts out laughing. Cut to black.',
      dialogue: [
        {
          speaker: 'Emma',
          line: 'That made my whole day. My cat is doing better in college than I am.',
        },
      ],
      usedExpressions: [
        {
          typedExpression: 'That made my whole day.',
          spokenPhrase: 'That made my whole day.',
          sourceMovie: 'Inside Out 2',
        },
      ],
      visualDirection: {
        environment: 'cafe',
        cameraFraming: 'wide',
        kenBurns: {
          startScale: 1.05,
          endScale: 1.0,
          startX: -6,
          endX: 6,
          startY: 0,
          endY: 0,
        },
        leftCharacterMood: 'deadpan',
        rightCharacterMood: 'laughing',
        activeProp: 'laptop_cat_party',
        cutToBlackAtEnd: true,
        visualAccentNote: 'Deadpan punchline and cut to black',
      },
    },
  ],
};

export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeLooseSearchText(text: string): string {
  return normalizeSearchText(text)
    .replace(/\+/g, ' ')
    .replace(/['.,!?~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchFixedExpressions(rawQuery: string): CourseExpression[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return FIXED_EXPRESSIONS;
  }

  const qNorm = normalizeSearchText(trimmed);
  const qLoose = normalizeLooseSearchText(trimmed);
  const qTokens = qLoose.split(' ').filter(Boolean);

  return FIXED_EXPRESSIONS.filter((item) => {
    const fields = [item.english, item.korean, item.movie];
    const joinedNorm = fields.map(normalizeSearchText).join(' ');
    const joinedLoose = fields.map(normalizeLooseSearchText).join(' ');

    if (joinedNorm.includes(qNorm) || (qLoose && joinedLoose.includes(qLoose))) {
      return true;
    }

    if (qTokens.length > 0) {
      return qTokens.every((tok) => joinedLoose.includes(tok));
    }

    return false;
  });
}

export function countDialogueWordsOnly(
  beats: Array<{ dialogue: Array<{ speaker: string; line: string }> }>
): number {
  return beats.reduce((total, beat) => {
    const words = beat.dialogue
      .map((turn) => turn.line.trim())
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    return total + words;
  }, 0);
}

export const ORIGINAL_SCENE_DEFAULTS = {
  place: 'University café',
  situation:
    "Emma accidentally emailed her cat's birthday slideshow instead of their academic presentation slides.",
};

export const LOCAL_STYLE_DIRECTIONS: Record<
  VisualStyleId,
  Record<BeatId, BeatSceneDirection>
> = {
  live_action: {
    hook: {
      style: 'live_action',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.0, endScale: 1.03, startX: -4, endX: 4, startY: 0, endY: 0 },
      leftCharacterMood: 'nervous',
      rightCharacterMood: 'curious',
      activeProp: 'laptop_slides',
      cutToBlackAtEnd: false,
      visualAccentNote: 'Live-action high-key sitcom two-shot',
    },
    problem: {
      style: 'live_action',
      environment: 'cafe',
      cameraFraming: 'over_shoulder',
      kenBurns: { startScale: 1.0, endScale: 1.035, startX: 4, endX: -4, startY: 1, endY: -1 },
      leftCharacterMood: 'embarrassed',
      rightCharacterMood: 'surprised',
      activeProp: 'laptop_cat_party',
      cutToBlackAtEnd: false,
      visualAccentNote: 'Live-action sitcom laptop reveal reaction',
    },
    turn: {
      style: 'live_action',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.01, endScale: 1.04, startX: 5, endX: -2, startY: -1, endY: 1 },
      leftCharacterMood: 'nervous',
      rightCharacterMood: 'amused',
      activeProp: 'email_alert',
      cutToBlackAtEnd: false,
      visualAccentNote: 'Live-action crisp reaction shot',
    },
    close: {
      style: 'live_action',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.02, endScale: 1.0, startX: -3, endX: 3, startY: 0, endY: 0 },
      leftCharacterMood: 'happy',
      rightCharacterMood: 'laughing',
      activeProp: 'laptop_cat_party',
      cutToBlackAtEnd: true,
      visualAccentNote: 'Medium two-shot pleased close & warm laugh',
    },
  },
  '3d_animation': {
    hook: {
      style: '3d_animation',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.0, endScale: 1.045, startX: -6, endX: 6, startY: 0, endY: -2 },
      leftCharacterMood: 'nervous',
      rightCharacterMood: 'curious',
      activeProp: 'laptop_slides',
      cutToBlackAtEnd: false,
      visualAccentNote: '3D animated café two-shot push-in',
    },
    problem: {
      style: '3d_animation',
      environment: 'cafe',
      cameraFraming: 'close_up',
      kenBurns: { startScale: 1.01, endScale: 1.05, startX: 6, endX: -6, startY: 2, endY: -2 },
      leftCharacterMood: 'embarrassed',
      rightCharacterMood: 'surprised',
      activeProp: 'laptop_cat_party',
      cutToBlackAtEnd: false,
      visualAccentNote: '3D animated cat birthday slideshow reveal',
    },
    turn: {
      style: '3d_animation',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.01, endScale: 1.05, startX: 7, endX: -2, startY: -2, endY: 1 },
      leftCharacterMood: 'nervous',
      rightCharacterMood: 'amused',
      activeProp: 'email_alert',
      cutToBlackAtEnd: false,
      visualAccentNote: '3D animated professor reply surprise',
    },
    close: {
      style: '3d_animation',
      environment: 'cafe',
      cameraFraming: 'wide',
      kenBurns: { startScale: 1.035, endScale: 1.0, startX: -5, endX: 5, startY: 0, endY: 0 },
      leftCharacterMood: 'happy',
      rightCharacterMood: 'laughing',
      activeProp: 'laptop_cat_party',
      cutToBlackAtEnd: true,
      visualAccentNote: '3D animated pleased closing & warm laugh',
    },
  },
  '2d_animation': {
    hook: {
      style: '2d_animation',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.0, endScale: 1.04, startX: -5, endX: 5, startY: 0, endY: 0 },
      leftCharacterMood: 'nervous',
      rightCharacterMood: 'curious',
      activeProp: 'laptop_slides',
      cutToBlackAtEnd: false,
      visualAccentNote: '2D cel-shaded sitcom two-shot',
    },
    problem: {
      style: '2d_animation',
      environment: 'cafe',
      cameraFraming: 'over_shoulder',
      kenBurns: { startScale: 1.01, endScale: 1.045, startX: 5, endX: -5, startY: 1, endY: -1 },
      leftCharacterMood: 'embarrassed',
      rightCharacterMood: 'surprised',
      activeProp: 'laptop_cat_party',
      cutToBlackAtEnd: false,
      visualAccentNote: '2D animated laptop slideshow turn',
    },
    turn: {
      style: '2d_animation',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.0, endScale: 1.04, startX: 5, endX: -5, startY: 0, endY: 0 },
      leftCharacterMood: 'nervous',
      rightCharacterMood: 'amused',
      activeProp: 'email_alert',
      cutToBlackAtEnd: false,
      visualAccentNote: '2D animated email reaction beat',
    },
    close: {
      style: '2d_animation',
      environment: 'cafe',
      cameraFraming: 'close_up',
      kenBurns: { startScale: 1.03, endScale: 1.0, startX: -4, endX: 4, startY: 0, endY: 0 },
      leftCharacterMood: 'happy',
      rightCharacterMood: 'laughing',
      activeProp: 'laptop_cat_party',
      cutToBlackAtEnd: true,
      visualAccentNote: '2D animated pleased close & warm laugh',
    },
  },
  american_comic: {
    hook: {
      style: 'american_comic',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.01, endScale: 1.05, startX: 7, endX: -7, startY: -2, endY: 2 },
      leftCharacterMood: 'nervous',
      rightCharacterMood: 'curious',
      activeProp: 'laptop_slides',
      cutToBlackAtEnd: false,
      visualAccentNote: 'Motion-comic sequential panel pan',
    },
    problem: {
      style: 'american_comic',
      environment: 'cafe',
      cameraFraming: 'over_shoulder',
      kenBurns: { startScale: 1.01, endScale: 1.055, startX: -7, endX: 6, startY: 2, endY: -2 },
      leftCharacterMood: 'embarrassed',
      rightCharacterMood: 'surprised',
      activeProp: 'laptop_cat_party',
      cutToBlackAtEnd: false,
      visualAccentNote: 'Graphic-novel cat reveal framing',
    },
    turn: {
      style: 'american_comic',
      environment: 'cafe',
      cameraFraming: 'medium_two_shot',
      kenBurns: { startScale: 1.01, endScale: 1.05, startX: 7, endX: -7, startY: -2, endY: 2 },
      leftCharacterMood: 'nervous',
      rightCharacterMood: 'amused',
      activeProp: 'email_alert',
      cutToBlackAtEnd: false,
      visualAccentNote: 'Motion-comic reaction drift',
    },
    close: {
      style: 'american_comic',
      environment: 'cafe',
      cameraFraming: 'close_up',
      kenBurns: { startScale: 1.045, endScale: 1.01, startX: -6, endX: 6, startY: 1, endY: -1 },
      leftCharacterMood: 'happy',
      rightCharacterMood: 'laughing',
      activeProp: 'laptop_cat_party',
      cutToBlackAtEnd: true,
      visualAccentNote: 'Comic-book pleased punchline & warm laugh',
    },
  },
};

export function getLocalBeatDirection(
  beatId: BeatId,
  style: VisualStyleId,
  variation = 0
): BeatSceneDirection {
  const base = LOCAL_STYLE_DIRECTIONS[style][beatId];
  if (variation === 0) {
    return { ...base, kenBurns: { ...base.kenBurns } };
  }
  const dirSign = variation % 2 === 1 ? -1 : 1;
  return {
    ...base,
    kenBurns: {
      startScale: Number((base.kenBurns.startScale + 0.005).toFixed(3)),
      endScale: Number(Math.min(1.06, base.kenBurns.endScale + 0.01).toFixed(3)),
      startX: base.kenBurns.startX * dirSign,
      endX: base.kenBurns.endX * dirSign,
      startY: base.kenBurns.startY * dirSign,
      endY: base.kenBurns.endY * dirSign,
    },
    visualAccentNote: `${base.visualAccentNote} (cam ${(variation % 3) + 1})`,
  };
}

export function isOriginalBeatScriptUnchanged(
  beat: StoryboardBeat,
  scene: SceneSetup
): boolean {
  const origBeat = ORIGINAL_STORYBOARD.beats.find((b) => b.id === beat.id);
  if (!origBeat) return false;

  const sameScene =
    scene.place.trim() === ORIGINAL_SCENE_DEFAULTS.place &&
    scene.situation.trim() === ORIGINAL_SCENE_DEFAULTS.situation &&
    beat.sceneDescription.trim() === origBeat.sceneDescription.trim();
  if (!sameScene) return false;

  if (beat.dialogue.length !== origBeat.dialogue.length) return false;
  return beat.dialogue.every(
    (turn, idx) =>
      turn.speaker.trim().toLowerCase() ===
        origBeat.dialogue[idx].speaker.trim().toLowerCase() &&
      turn.line.trim() === origBeat.dialogue[idx].line.trim()
  );
}
