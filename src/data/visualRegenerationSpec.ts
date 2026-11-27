import { BeatId, VisualStyleId } from '../types';

export interface CharacterAndPropBible {
  emma: string;
  chloe: string;
  laptopSpec: string;
  settingSpec: string;
  prohibitions: string[];
}

export interface ShotGenerationBrief {
  beatId: BeatId;
  style: VisualStyleId;
  targetAssetPath: string;
  needsRegeneration: boolean;
  framing: string;
  prompt: string;
}

export interface RegenerationBatchStep {
  order: number;
  style: VisualStyleId | 'preview_cards';
  label: string;
  onlyIfNecessary?: boolean;
  assets: Array<{
    beatId: BeatId;
    currentAssetPath: string;
    reason: string;
  }>;
}

export const GLOBAL_VISUAL_PROHIBITIONS: string[] = [
  'Zero brand logos on laptops, coffee cups, or clothing',
  'Zero floating graphic overlays, inset cards, stickers, or speech bubbles',
  'All screen content (cat birthday slideshow, email reply) must appear strictly inside the physical laptop display in natural perspective',
  'Keep all character faces and props clearly visible and unobstructed within a 16:9 frame',
];

export const CHARACTER_PROP_CONSISTENCY_BY_STYLE: Record<
  VisualStyleId,
  CharacterAndPropBible
> = {
  live_action: {
    emma:
      'Attractive, youthful college-age young woman (early 20s), long wavy dark brown hair, large dark almond eyes, defined eyebrows, natural clear light skin, solid mustard-yellow college crewneck over crisp white collar, no glasses.',
    chloe:
      'Attractive, youthful college-age young woman (early 20s), long light blonde hair with soft natural waves, bright blue/gray-blue eyes, fair clear skin, no glasses, fitted teal cardigan over white tee.',
    laptopSpec:
      'Identical matte silver unbranded 14-inch aluminum college laptop (rounded corners, slim black screen bezel, single centered dark hinge bar) positioned centrally/diagonally so both characters can see the screen.',
    settingSpec:
      'Bright modern college campus café with even high-key teen-sitcom TV studio lighting, neutral-to-cool white balance, clean white subway tile counter, fresh mint-teal booth seating, light maple table.',
    prohibitions: GLOBAL_VISUAL_PROHIBITIONS,
  },
  '2d_animation': {
    emma:
      'Youthful college-age cartoon heroine in classic American TV animation style: bold clean ink outlines, simplified appealing shapes, long wavy dark brown hair, no glasses, solid sunny-gold sweater with cream collar, flat bright cel colors.',
    chloe:
      'Youthful college-age cartoon best friend in classic American TV animation style: bold clean ink outlines, long wavy light blonde hair, bright blue eyes, no glasses, bright teal cardigan over white top, lively appealing silhouette.',
    laptopSpec:
      'STRICTLY IDENTICAL matte silver-gray 2D cartoon laptop across ALL 4 beats positioned centrally so both can see the display, zero logos.',
    settingSpec:
      'Clean flat-colored American TV cartoon campus café background with teal booth bench, wood tabletop, and cream/green café window backdrop consistent across all beats.',
    prohibitions: GLOBAL_VISUAL_PROHIBITIONS,
  },
  '3d_animation': {
    emma:
      'Youthful stylized 3D animated college student (early 20s): softer rounded youthful face, expressive large dark eyes, long wavy dark brown hair, no glasses, mustard-gold knit sweater over crisp white collar.',
    chloe:
      'Youthful stylized 3D animated college friend (early 20s): expressive large bright blue animated eyes, long wavy light blonde hair, fair clear skin, no glasses, clean teal cardigan over ivory top.',
    laptopSpec:
      'Identical matte silver-white 3D stylized unbranded laptop positioned centrally/diagonally so both can see the screen across all four beats.',
    settingSpec:
      'Clean, bright 3D animated college café in neutral-daylight studio lighting with gridded windows and wood table (no yellow or orange color drift).',
    prohibitions: GLOBAL_VISUAL_PROHIBITIONS,
  },
  american_comic: {
    emma:
      'Youthful college-age female character drawn in modern American graphic-novel comic style: clean black ink outlines, crisp cel-and-halftone shading, long wavy dark brown hair, no glasses, mustard sweater over white collar.',
    chloe:
      'Youthful college-age female friend in modern American graphic-novel comic style: clean ink outlines, long wavy light blonde hair, blue eyes, no glasses, teal cardigan over white tee.',
    laptopSpec:
      'Identical clean silver-gray unbranded comic-inked laptop positioned centrally so both characters can view the screen across all four beats.',
    settingSpec:
      'Clean modern paper-toned graphic-novel college café with counter left and sunlit windows right across every beat (zero speech bubbles).',
    prohibitions: GLOBAL_VISUAL_PROHIBITIONS,
  },
};

export const UPDATED_STYLE_BRIEFS: Record<VisualStyleId, string> = {
  live_action:
    'LIVE-ACTION TEEN SITCOM: Bright Disney Channel / Nickelodeon-era teen sitcom and campus comedy aesthetic with original fictional college characters. Even, crisp high-key television studio lighting, neutral-to-cool white balance, friendly natural styling, less glossy ad-campaign polish, more authentic TV sitcom staging and restrained, readable comedic acting (no exaggerated open-mouth shock).',
  '2d_animation':
    '2D AMERICAN TV CARTOON: Classic American TV cartoon energy with bold confident outlines, simplified appealing character shapes, playful clean expressions, flat vibrant color design, and youthful lively comedic tone (not a soft children’s picture book). Maintain an identical laptop shape, size, hinge, and color across every beat.',
  '3d_animation':
    '3D ANIMATION (YOUTHFUL & CLEAN): Stylized playful 3D animated college comedy using a clean neutral-to-warm palette (reduce yellow/orange cast). Characters must clearly read as attractive, youthful college students with larger expressive animated eyes and softer youthful facial geometry—never mature or middle-aged.',
  american_comic:
    'AMERICAN COMIC BOOK (CLEAN PAPER TONE): Crisp modern graphic-novel / motion-comic style with clear ink outlines, subtle halftone texture, high contrast, and clean neutral-ivory paper tones (reduce heavy yellow tint and avoid muddy coloring). No speech bubbles or random lettering.',
};

const CURRENT_ASSET_PATHS: Record<VisualStyleId, Record<BeatId, string>> = {
  live_action: {
    hook: '/src/assets/images/live_hook_v4_1795683336850.jpg',
    problem: '/src/assets/images/live_problem_v5_1795683967023.jpg',
    turn: '/src/assets/images/live_turn_v4_1795683342615.jpg',
    close: '/src/assets/images/live_close_v3_1795681900444.jpg',
  },
  '2d_animation': {
    hook: '/src/assets/images/anim2d_hook_v3_1795681839874.jpg',
    problem: '/src/assets/images/anim2d_problem_v5_1795683340859.jpg',
    turn: '/src/assets/images/anim2d_turn_v5_1795683345432.jpg',
    close: '/src/assets/images/anim2d_close_v4_1795681926578.jpg',
  },
  '3d_animation': {
    hook: '/src/assets/images/anim3d_hook_v3_1795681837924.jpg',
    problem: '/src/assets/images/anim3d_problem_v4_1795683339749.jpg',
    turn: '/src/assets/images/anim3d_turn_v4_1795683344365.jpg',
    close: '/src/assets/images/anim3d_close_v3_1795681906134.jpg',
  },
  american_comic: {
    hook: '/src/assets/images/comic_hook_v3_1795681839482.jpg',
    problem: '/src/assets/images/comic_problem_v4_1795683341997.jpg',
    turn: '/src/assets/images/comic_turn_v6_1795683345812.jpg',
    close: '/src/assets/images/comic_close_v3_1795681917984.jpg',
  },
};

function buildShotPrompt(style: VisualStyleId, beatId: BeatId): string {
  const bible = CHARACTER_PROP_CONSISTENCY_BY_STYLE[style];
  const styleHeader = UPDATED_STYLE_BRIEFS[style];

  const beatBriefs: Record<BeatId, string> =
    style === 'live_action'
      ? {
          hook: 'BEAT 1 — HOOK (Medium two-shot): Bright modern campus café TV sitcom framing. Emma looks subtly nervous toward her open laptop; Chloe leans slightly forward noticing with gentle concern. Subtle, believable expressions, natural teen sitcom composition, clear crisp high-key studio lighting.',
          problem:
            'BEAT 2 — PROBLEM (Over-the-shoulder / angled two-shot from Emma’s side): Emma turns her open matte-silver laptop toward Chloe so Chloe can plausibly see the screen. Clearly visible strictly INSIDE the physical laptop screen is a colorful birthday slideshow photo of an orange tabby cat wearing a tiny party hat. Chloe reacts with surprised amusement (NOT extreme open-mouth shock); Emma looks visibly embarrassed (NOT cheerful).',
          turn: 'BEAT 3 — TURN (Tighter two-shot around the laptop): Chloe reads the professor’s reply on the laptop screen and looks amused and delighted with a natural restrained smile and slightly raised eyebrows (no lip-biting or odd exaggerated mouth shapes). Emma sits beside her looking anxious and embarrassed while waiting for the reaction (no angry expression or deep frown).',
          close:
            'BEAT 4 — CLOSE (Medium two-shot in identical café): Both Emma and Chloe can naturally see the centrally/diagonally placed laptop screen. Emma holds her iced coffee with a genuinely positive, lightly amused, pleased smile as she delivers "That made my whole day." Beside her, Chloe reacts with a natural, restrained laugh/warm smile. Clean, balanced composition.',
        }
      : {
          hook: 'BEAT 1 — HOOK (Medium two-shot): Emma sits at the café table looking nervously at her open unbranded laptop while Chloe puts down her iced coffee and notices with curious concern.',
          problem:
            'BEAT 2 — PROBLEM (Over-the-shoulder / angled two-shot): Emma turns the identical unbranded laptop toward Chloe so Chloe can realistically see the display. Strictly inside the physical laptop display is a colorful birthday slideshow of a cat in a tiny party hat. Emma looks embarrassed; Chloe reacts with surprised amusement.',
          turn: 'BEAT 3 — TURN (Tighter two-shot around the laptop): Chloe leans toward the identical laptop screen reading the professor’s email reply with amused delight and raised eyebrows; Emma waits beside her looking anxious and hopeful.',
          close:
            'BEAT 4 — CLOSE (Medium two-shot in identical café): Both Emma and Chloe can see the laptop screen. Emma looks pleased with a genuinely positive, lightly amused smile while Chloe responds with a natural, restrained laugh beside her.',
        };

  return [
    styleHeader,
    beatBriefs[beatId],
    `Emma: ${bible.emma}`,
    `Chloe: ${bible.chloe}`,
    `Laptop consistency: ${bible.laptopSpec}`,
    `Setting: ${bible.settingSpec}`,
    `Strict rules: ${bible.prohibitions.join('; ')}. 16:9 widescreen composition.`,
  ].join('\n');
}

export const STORED_SHOT_BRIEFS: Record<
  VisualStyleId,
  Record<BeatId, ShotGenerationBrief>
> = {
  live_action: {
    hook: {
      beatId: 'hook',
      style: 'live_action',
      targetAssetPath: CURRENT_ASSET_PATHS.live_action.hook,
      needsRegeneration: false,
      framing: 'Medium two-shot',
      prompt: buildShotPrompt('live_action', 'hook'),
    },
    problem: {
      beatId: 'problem',
      style: 'live_action',
      targetAssetPath: CURRENT_ASSET_PATHS.live_action.problem,
      needsRegeneration: false,
      framing: 'Over-the-shoulder angled two-shot',
      prompt: buildShotPrompt('live_action', 'problem'),
    },
    turn: {
      beatId: 'turn',
      style: 'live_action',
      targetAssetPath: CURRENT_ASSET_PATHS.live_action.turn,
      needsRegeneration: false,
      framing: 'Tighter two-shot around laptop',
      prompt: buildShotPrompt('live_action', 'turn'),
    },
    close: {
      beatId: 'close',
      style: 'live_action',
      targetAssetPath: CURRENT_ASSET_PATHS.live_action.close,
      needsRegeneration: false,
      framing: 'Medium two-shot / slight medium close',
      prompt: buildShotPrompt('live_action', 'close'),
    },
  },
  '2d_animation': {
    hook: {
      beatId: 'hook',
      style: '2d_animation',
      targetAssetPath: CURRENT_ASSET_PATHS['2d_animation'].hook,
      needsRegeneration: false,
      framing: 'Medium two-shot',
      prompt: buildShotPrompt('2d_animation', 'hook'),
    },
    problem: {
      beatId: 'problem',
      style: '2d_animation',
      targetAssetPath: CURRENT_ASSET_PATHS['2d_animation'].problem,
      needsRegeneration: false,
      framing: 'Over-the-shoulder angled two-shot',
      prompt: buildShotPrompt('2d_animation', 'problem'),
    },
    turn: {
      beatId: 'turn',
      style: '2d_animation',
      targetAssetPath: CURRENT_ASSET_PATHS['2d_animation'].turn,
      needsRegeneration: false,
      framing: 'Tighter two-shot',
      prompt: buildShotPrompt('2d_animation', 'turn'),
    },
    close: {
      beatId: 'close',
      style: '2d_animation',
      targetAssetPath: CURRENT_ASSET_PATHS['2d_animation'].close,
      needsRegeneration: false,
      framing: 'Medium two-shot',
      prompt: buildShotPrompt('2d_animation', 'close'),
    },
  },
  '3d_animation': {
    hook: {
      beatId: 'hook',
      style: '3d_animation',
      targetAssetPath: CURRENT_ASSET_PATHS['3d_animation'].hook,
      needsRegeneration: false,
      framing: 'Medium two-shot',
      prompt: buildShotPrompt('3d_animation', 'hook'),
    },
    problem: {
      beatId: 'problem',
      style: '3d_animation',
      targetAssetPath: CURRENT_ASSET_PATHS['3d_animation'].problem,
      needsRegeneration: false,
      framing: 'Over-the-shoulder angled two-shot',
      prompt: buildShotPrompt('3d_animation', 'problem'),
    },
    turn: {
      beatId: 'turn',
      style: '3d_animation',
      targetAssetPath: CURRENT_ASSET_PATHS['3d_animation'].turn,
      needsRegeneration: false,
      framing: 'Tighter two-shot',
      prompt: buildShotPrompt('3d_animation', 'turn'),
    },
    close: {
      beatId: 'close',
      style: '3d_animation',
      targetAssetPath: CURRENT_ASSET_PATHS['3d_animation'].close,
      needsRegeneration: false,
      framing: 'Medium two-shot',
      prompt: buildShotPrompt('3d_animation', 'close'),
    },
  },
  american_comic: {
    hook: {
      beatId: 'hook',
      style: 'american_comic',
      targetAssetPath: CURRENT_ASSET_PATHS.american_comic.hook,
      needsRegeneration: false,
      framing: 'Medium two-shot',
      prompt: buildShotPrompt('american_comic', 'hook'),
    },
    problem: {
      beatId: 'problem',
      style: 'american_comic',
      targetAssetPath: CURRENT_ASSET_PATHS.american_comic.problem,
      needsRegeneration: false,
      framing: 'Over-the-shoulder angled two-shot',
      prompt: buildShotPrompt('american_comic', 'problem'),
    },
    turn: {
      beatId: 'turn',
      style: 'american_comic',
      targetAssetPath: CURRENT_ASSET_PATHS.american_comic.turn,
      needsRegeneration: false,
      framing: 'Tighter two-shot',
      prompt: buildShotPrompt('american_comic', 'turn'),
    },
    close: {
      beatId: 'close',
      style: 'american_comic',
      targetAssetPath: CURRENT_ASSET_PATHS.american_comic.close,
      needsRegeneration: false,
      framing: 'Medium two-shot',
      prompt: buildShotPrompt('american_comic', 'close'),
    },
  },
};

export const MINIMAL_REGENERATION_PLAN: RegenerationBatchStep[] = [
  {
    order: 1,
    style: 'live_action',
    label: 'Live-action storyboard images',
    assets: [
      {
        beatId: 'hook',
        currentAssetPath: CURRENT_ASSET_PATHS.live_action.hook,
        reason: 'Youthful college-age teen sitcom cast/lighting (less glossy ad look)',
      },
      {
        beatId: 'problem',
        currentAssetPath: CURRENT_ASSET_PATHS.live_action.problem,
        reason: 'Over-the-shoulder angle so Chloe can plausibly see cat slideshow inside laptop',
      },
      {
        beatId: 'turn',
        currentAssetPath: CURRENT_ASSET_PATHS.live_action.turn,
        reason: 'Tighter two-shot: Chloe amused smile/eyebrows, Emma anxious (no frown/lip-bite)',
      },
      {
        beatId: 'close',
        currentAssetPath: CURRENT_ASSET_PATHS.live_action.close,
        reason: 'Clear deadpan Emma delivery & warm restrained sitcom laugh from Chloe',
      },
    ],
  },
  {
    order: 2,
    style: '2d_animation',
    label: '2D Animation storyboard images',
    assets: [
      {
        beatId: 'hook',
        currentAssetPath: CURRENT_ASSET_PATHS['2d_animation'].hook,
        reason: 'Classic American TV cartoon look with bold outlines and baseline laptop model',
      },
      {
        beatId: 'problem',
        currentAssetPath: CURRENT_ASSET_PATHS['2d_animation'].problem,
        reason: 'Identical laptop design & cat birthday slideshow contained inside screen',
      },
      {
        beatId: 'turn',
        currentAssetPath: CURRENT_ASSET_PATHS['2d_animation'].turn,
        reason: 'Identical laptop & crisp classic TV cartoon reaction framing',
      },
      {
        beatId: 'close',
        currentAssetPath: CURRENT_ASSET_PATHS['2d_animation'].close,
        reason: 'Identical laptop & clean deadpan/warm laugh cartoon finale',
      },
    ],
  },
  {
    order: 3,
    style: '3d_animation',
    label: '3D Animation storyboard images',
    assets: [
      {
        beatId: 'hook',
        currentAssetPath: CURRENT_ASSET_PATHS['3d_animation'].hook,
        reason: 'Remove yellow cast; make characters clearly youthful college students',
      },
      {
        beatId: 'problem',
        currentAssetPath: CURRENT_ASSET_PATHS['3d_animation'].problem,
        reason: 'Neutral-to-warm clean 3D look, youthful faces, larger expressive animated eyes',
      },
      {
        beatId: 'turn',
        currentAssetPath: CURRENT_ASSET_PATHS['3d_animation'].turn,
        reason: 'Neutral-to-warm clean 3D look with consistent laptop and youthful characters',
      },
      {
        beatId: 'close',
        currentAssetPath: CURRENT_ASSET_PATHS['3d_animation'].close,
        reason: 'Youthful deadpan Emma & warm Chloe laugh in clean 3D palette',
      },
    ],
  },
  {
    order: 4,
    style: 'american_comic',
    label: 'American Comic Book storyboard images',
    assets: [
      {
        beatId: 'hook',
        currentAssetPath: CURRENT_ASSET_PATHS.american_comic.hook,
        reason: 'Reduce yellow tint to crisp neutral paper tones with bold ink outlines',
      },
      {
        beatId: 'problem',
        currentAssetPath: CURRENT_ASSET_PATHS.american_comic.problem,
        reason: 'Cleaner paper contrast & consistent laptop with cat slideshow inside screen',
      },
      {
        beatId: 'turn',
        currentAssetPath: CURRENT_ASSET_PATHS.american_comic.turn,
        reason: 'Clean graphic-novel tones, consistent characters and laptop',
      },
      {
        beatId: 'close',
        currentAssetPath: CURRENT_ASSET_PATHS.american_comic.close,
        reason: 'Crisp comic-book contrast & deadpan/warm laugh framing',
      },
    ],
  },
  {
    order: 5,
    style: 'preview_cards',
    label: 'Style preview cards (only if necessary)',
    onlyIfNecessary: true,
    assets: [
      {
        beatId: 'hook',
        currentAssetPath: CURRENT_ASSET_PATHS.live_action.hook,
        reason: 'Preview card shares Hook frame; automatically updated once Hook beats regenerate',
      },
    ],
  },
];
