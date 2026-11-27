import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Edit3,
  Film,
  LayoutGrid,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Table2,
  X,
} from 'lucide-react';
import {
  FIXED_EXPRESSIONS,
  VISUAL_STYLE_OPTIONS,
  countDialogueWordsOnly,
} from '../data/courseExpressions';
import { preloadStyleAssets, renderBeatFrame } from '../engine/sceneRenderer';
import {
  BeatSceneDirection,
  MatchedExpressionSpan,
  StoryboardBeat,
  StoryboardData,
  VisualStyleId,
} from '../types';

interface StoryboardStepProps {
  storyboard: StoryboardData;
  style: VisualStyleId;
  onUpdateBeat: (beatId: string, updated: StoryboardBeat) => void;
  onRegenerateBeatVisual: (beatId: string) => Promise<void>;
  onResetToOriginal: () => void;
  regeneratingBeatId: string | null;
  errorMessage?: string | null;
  onBack: () => void;
  onProceedToVideo: () => void;
}

interface ClickedExpressionDetail {
  beatId: string;
  typedExpression: string;
  spokenPhrase: string;
  korean: string;
  sourceMovie: string;
}

function getKoreanMeaning(typedExpression: string): string {
  const found = FIXED_EXPRESSIONS.find(
    (e) =>
      e.english.replace(/[’']/g, "'").toLowerCase() ===
      typedExpression.replace(/[’']/g, "'").toLowerCase()
  );
  return found?.korean ?? '';
}

const DEFAULT_PREVIEW_DIRECTION: BeatSceneDirection = {
  environment: 'cafe',
  cameraFraming: 'medium_two_shot',
  kenBurns: {
    startScale: 1,
    endScale: 1.06,
    startX: -8,
    endX: 8,
    startY: 0,
    endY: 0,
  },
  leftCharacterMood: 'neutral',
  rightCharacterMood: 'neutral',
  activeProp: 'laptop_slides',
  visualAccentNote: '',
};

const BeatVisualPreview: React.FC<{
  beat: StoryboardBeat;
  storyboard: StoryboardData;
  style: VisualStyleId;
}> = ({ beat, storyboard, style }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [problemShot, setProblemShot] = useState<'insert' | 'twoshot'>('insert');

  useEffect(() => {
    let cancelled = false;
    const dur = Math.max(4, beat.endSec - beat.startSec);
    const previewElapsedSec =
      beat.id === 'problem'
        ? problemShot === 'insert'
          ? 0.8
          : Math.max(2.5, dur * 0.65)
        : 1.4;

    const draw = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      renderBeatFrame({
        ctx,
        width: canvas.width,
        height: canvas.height,
        style,
        storyboard,
        direction: beat.visualDirection ?? DEFAULT_PREVIEW_DIRECTION,
        beatId: beat.id,
        beatElapsedSec: previewElapsedSec,
        beatDurationSec: dur,
        activeSpeaker: null,
        isPlayingAudio: false,
      });
    };

    draw();
    preloadStyleAssets(style)
      .then(() => draw())
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [beat, storyboard, style, problemShot]);

  return (
    <div className="mb-4">
      <div
        className="w-full rounded-2xl overflow-hidden border border-[#722F37]/15 bg-[#29151E]"
        style={{ aspectRatio: '16 / 9' }}
      >
        <canvas
          ref={canvasRef}
          width={640}
          height={360}
          className="w-full h-full block object-cover object-center"
        />
      </div>
      {beat.id === 'problem' && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[#722F37]/80">
            Timeline cut: Laptop Insert → Return Two-Shot
          </span>
          <div className="inline-flex items-center gap-1 rounded-full bg-[#EFE7D8]/90 p-0.5 border border-[#722F37]/15">
            <button
              type="button"
              onClick={() => setProblemShot('insert')}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                problemShot === 'insert'
                  ? 'bg-[#722F37] text-[#F5F0E6]'
                  : 'text-[#21191B]/70 hover:text-[#21191B]'
              }`}
            >
              Shot 1: Laptop Insert
            </button>
            <button
              type="button"
              onClick={() => setProblemShot('twoshot')}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                problemShot === 'twoshot'
                  ? 'bg-[#722F37] text-[#F5F0E6]'
                  : 'text-[#21191B]/70 hover:text-[#21191B]'
              }`}
            >
              Shot 2: Two-Shot Cut
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const StoryboardStep: React.FC<StoryboardStepProps> = ({
  storyboard,
  style,
  onUpdateBeat,
  onRegenerateBeatVisual,
  onResetToOriginal,
  regeneratingBeatId,
  errorMessage,
  onBack,
  onProceedToVideo,
}) => {
  const styleOption = VISUAL_STYLE_OPTIONS.find((s) => s.id === style);
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [editingBeatId, setEditingBeatId] = useState<string | null>(null);
  const [draftScene, setDraftScene] = useState('');
  const [draftDialogueText, setDraftDialogueText] = useState('');
  const [activeDetail, setActiveDetail] = useState<ClickedExpressionDetail | null>(null);

  const totalWords = useMemo(
    () => countDialogueWordsOnly(storyboard.beats),
    [storyboard.beats]
  );

  const startEditing = (beat: StoryboardBeat) => {
    setEditingBeatId(beat.id);
    setDraftScene(beat.sceneDescription);
    setDraftDialogueText(
      beat.dialogue.map((d) => `${d.speaker}: ${d.line}`).join('\n')
    );
  };

  const saveEdit = (beat: StoryboardBeat) => {
    const lines = draftDialogueText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((raw) => {
        const colonIdx = raw.indexOf(':');
        if (colonIdx > 0 && colonIdx < 24) {
          return {
            speaker: raw.slice(0, colonIdx).trim(),
            line: raw.slice(colonIdx + 1).trim(),
          };
        }
        return {
          speaker: storyboard.characters[0]?.name || 'Emma',
          line: raw,
        };
      });

    onUpdateBeat(beat.id, {
      ...beat,
      sceneDescription: draftScene.trim(),
      dialogue: lines,
    });
    setEditingBeatId(null);
  };

  const renderHighlightedDialogue = (
    text: string,
    usedExpressions: MatchedExpressionSpan[],
    beatId: string
  ): React.ReactNode => {
    const spans = usedExpressions.filter((u) => u.spokenPhrase.trim().length > 0);
    if (spans.length === 0) return text;

    const sorted = [...spans].sort(
      (a, b) => b.spokenPhrase.length - a.spokenPhrase.length
    );
    const escaped = sorted.map((s) =>
      s.spokenPhrase
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/[’']/g, "[’']")
    );
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    const parts = text.split(regex);

    return parts.map((part, idx) => {
      const matched = sorted.find(
        (s) =>
          s.spokenPhrase.replace(/[’']/g, "'").toLowerCase() ===
          part.replace(/[’']/g, "'").toLowerCase()
      );
      if (!matched) {
        return <React.Fragment key={idx}>{part}</React.Fragment>;
      }

      return (
        <button
          key={idx}
          type="button"
          onClick={() =>
            setActiveDetail((curr) =>
              curr?.beatId === beatId &&
              curr.typedExpression === matched.typedExpression
                ? null
                : {
                    beatId,
                    typedExpression: matched.typedExpression,
                    spokenPhrase: matched.spokenPhrase,
                    korean: getKoreanMeaning(matched.typedExpression),
                    sourceMovie: matched.sourceMovie,
                  }
            )
          }
          className="inline bg-[#C4A574]/35 hover:bg-[#C4A574]/55 text-[#21191B] font-semibold px-1.5 py-0.5 rounded-sm border-b-2 border-[#722F37] cursor-pointer transition-colors"
          title="Click to view Korean meaning and source movie"
        >
          {part}
        </button>
      );
    });
  };

  return (
    <section className="cinema-enter max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-32 md:pb-16 overflow-x-hidden">
      <div className="mb-7 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <p className="text-xs sm:text-sm font-medium tracking-wide text-[#E5C9AD] mb-2">
            Act III · Behind the Scenes
          </p>
          <h1 className="font-display text-3xl sm:text-5xl font-bold text-[#F5F0E6] tracking-tight text-balance">
            {storyboard.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm sm:text-base text-[#F5F0E6]/80">
            <span className="font-mono tabular-nums font-semibold text-[#E5C9AD]">
              {totalWords} words
            </span>
            <span aria-hidden="true" className="text-[#E5C9AD]/50">
              ·
            </span>
            <span>
              Cast: {storyboard.characters.map((c) => c.name).join(' & ')}
            </span>
            <span aria-hidden="true" className="text-[#E5C9AD]/50">
              ·
            </span>
            <span className="font-semibold text-[#E5C9AD]">
              Style: {styleOption?.title || style}
            </span>
            <span aria-hidden="true" className="text-[#E5C9AD]/50">
              ·
            </span>
            <span>Click any highlighted line for Korean meaning</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-auto">
          <button
            type="button"
            onClick={onResetToOriginal}
            className="liquid-glass-btn-secondary min-h-[44px] px-4 py-2 rounded-full text-sm font-semibold flex items-center gap-2 whitespace-nowrap"
          >
            <RotateCcw className="w-4 h-4 text-[#E5C9AD]" />
            Reset to Original Script
          </button>

          <div className="liquid-glass-panel flex items-center gap-1 p-1 rounded-full">
            <button
              type="button"
              onClick={() => setViewMode('cards')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-full text-sm font-semibold flex items-center gap-2 transition-colors ${
                viewMode === 'cards'
                  ? 'bg-[#722F37]/90 text-[#F5F0E6] border border-[#E5C9AD]/35'
                  : 'text-[#F5F0E6]/72 hover:text-[#F5F0E6] border border-transparent'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
              Frames
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-full text-sm font-semibold flex items-center gap-2 transition-colors ${
                viewMode === 'table'
                  ? 'bg-[#722F37]/90 text-[#F5F0E6] border border-[#E5C9AD]/35'
                  : 'text-[#F5F0E6]/72 hover:text-[#F5F0E6] border border-transparent'
              }`}
            >
              <Table2 className="w-4 h-4" />
              Table
            </button>
          </div>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="liquid-glass-panel mb-6 p-4 rounded-[20px] text-[#F5F0E6] text-base font-medium"
        >
          {errorMessage}
        </div>
      )}

      {/* Selected Expression Detail Bar */}
      {activeDetail && (
        <div
          role="status"
          className="cinema-enter liquid-glass-ivory mb-6 p-4 sm:p-5 rounded-[20px] text-[#21191B] flex items-start justify-between gap-4"
        >
          <div>
            <p className="text-xs font-semibold text-[#722F37] mb-1 flex items-center gap-1.5">
              <Film className="w-3.5 h-3.5" aria-hidden="true" />
              Source Movie: {activeDetail.sourceMovie}
            </p>
            <p className="text-lg font-bold text-[#21191B]">
              {activeDetail.typedExpression}
              {activeDetail.spokenPhrase !== activeDetail.typedExpression && (
                <span className="text-sm font-normal text-[#21191B]/70 ml-2">
                  (In dialogue: “{activeDetail.spokenPhrase}”)
                </span>
              )}
            </p>
            <p className="text-base text-[#21191B]/85 mt-1">{activeDetail.korean}</p>
          </div>
          <button
            type="button"
            aria-label="Close expression detail"
            onClick={() => setActiveDetail(null)}
            className="min-h-[40px] min-w-[40px] rounded-full text-[#21191B]/60 hover:bg-[#21191B]/10 flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {viewMode === 'cards' ? (
        <div className="@container">
          <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-6 items-stretch">
            {storyboard.beats.map((beat, idx) => {
              const isEditing = editingBeatId === beat.id;
              const isRegenerating = regeneratingBeatId === beat.id;

              return (
                <article
                  key={beat.id}
                  className="liquid-glass-ivory w-full h-full text-[#21191B] rounded-[22px] overflow-hidden flex flex-col justify-between min-w-0"
                >
                  {/* Translucent Plum Header Bar */}
                  <div className="min-w-0">
                    <div className="bg-[#29151E]/92 px-4 sm:px-5 py-3.5 border-b border-[#E5C9AD]/20 flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="block text-xs font-mono tabular-nums font-semibold text-[#E5C9AD]">
                          Scene 0{idx + 1} · {beat.timeRange}
                        </span>
                        <h2 className="font-display text-xl font-bold text-[#F5F0E6] truncate">
                          {beat.label}
                        </h2>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {!isEditing && (
                          <button
                            type="button"
                            onClick={() => startEditing(beat)}
                            className="min-h-[38px] px-3.5 py-1.5 rounded-full bg-[#F5F0E6]/10 border border-[#E5C9AD]/30 text-xs font-medium text-[#F5F0E6] hover:bg-[#722F37]/75 flex items-center gap-1.5 transition-colors"
                          >
                            <Edit3 className="w-3.5 h-3.5 text-[#E5C9AD]" />
                            Edit
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isRegenerating || isEditing}
                          onClick={() => onRegenerateBeatVisual(beat.id)}
                          title="Regenerate visual presentation only (preserves original dialogue)"
                          className="min-h-[38px] px-3.5 py-1.5 rounded-full bg-[#F5F0E6]/10 border border-[#E5C9AD]/30 text-xs font-medium text-[#F5F0E6] hover:bg-[#722F37]/75 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                        >
                          {isRegenerating ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#E5C9AD]" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5 text-[#E5C9AD]" />
                          )}
                          Visuals
                        </button>
                      </div>
                    </div>

                    {/* Frame Content */}
                    <div className="p-4 sm:p-6 min-w-0">
                    {isEditing ? (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-semibold text-[#722F37] mb-1.5">
                            Scene description
                          </label>
                          <textarea
                            rows={3}
                            value={draftScene}
                            onChange={(e) => setDraftScene(e.target.value)}
                            className="w-full p-3 rounded-lg bg-white border border-[#C4A574]/60 text-base text-[#21191B] focus:outline-none focus:ring-2 focus:ring-[#722F37]"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-[#722F37] mb-1.5">
                            English dialogue & subtitles (Speaker: Line)
                          </label>
                          <textarea
                            rows={4}
                            value={draftDialogueText}
                            onChange={(e) => setDraftDialogueText(e.target.value)}
                            className="w-full p-3 rounded-lg bg-white border border-[#C4A574]/60 text-base text-[#21191B] focus:outline-none focus:ring-2 focus:ring-[#722F37]"
                          />
                        </div>
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            type="button"
                            onClick={() => setEditingBeatId(null)}
                            className="min-h-[42px] px-4 py-2 rounded-full border border-[#722F37]/25 text-sm font-semibold text-[#21191B] hover:bg-[#EFE7D8] flex items-center gap-1.5"
                          >
                            <X className="w-4 h-4" />
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => saveEdit(beat)}
                            className="liquid-glass-btn-primary min-h-[42px] px-5 py-2 rounded-full text-sm font-semibold flex items-center gap-1.5"
                          >
                            <Save className="w-4 h-4" />
                            Save Frame
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <BeatVisualPreview
                          beat={beat}
                          storyboard={storyboard}
                          style={style}
                        />
                        <div className="mb-4 min-w-0">
                          <p className="text-xs font-semibold text-[#722F37] mb-1">
                            Scene Description
                          </p>
                          <p className="text-base text-[#21191B]/85 leading-relaxed break-words">
                            {beat.sceneDescription}
                          </p>
                          {beat.visualDirection && (
                            <p className="mt-1.5 text-xs text-[#722F37]/85 font-medium break-words">
                              Camera: {beat.visualDirection.cameraFraming.replace(/_/g, ' ')} ·{' '}
                              {beat.visualDirection.visualAccentNote}
                            </p>
                          )}
                        </div>

                        <div className="p-4 rounded-2xl bg-white/75 border border-[#722F37]/12 space-y-2.5 min-w-0">
                          <p className="text-xs font-semibold text-[#722F37]">
                            English Dialogue & Subtitles
                          </p>
                          {beat.dialogue.map((turn, ti) => (
                            <p
                              key={ti}
                              className="text-base text-[#21191B] leading-relaxed break-words"
                            >
                              <span className="font-bold text-[#722F37]">
                                {turn.speaker}:{' '}
                              </span>
                              {renderHighlightedDialogue(
                                turn.line,
                                beat.usedExpressions,
                                beat.id
                              )}
                            </p>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="px-5 sm:px-6 py-3.5 bg-[#EFE7D8]/70 border-t border-[#722F37]/12 text-sm text-[#21191B]/80 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-[#21191B]">Expressions: </span>
                    <span className="font-medium text-[#722F37]">
                      {beat.usedExpressions.map((u) => u.typedExpression).join(', ')}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-[#21191B]/75">
                    {Array.from(
                      new Set(beat.usedExpressions.map((u) => u.sourceMovie))
                    ).join(' · ')}
                  </div>
                </div>
              </article>
            );
          })}
          </div>
        </div>
      ) : (
        <div className="liquid-glass-ivory text-[#21191B] rounded-[22px] overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[820px]">
            <thead>
              <tr className="bg-[#29151E]/92 text-[#F5F0E6] border-b border-[#E5C9AD]/20 text-sm font-semibold">
                <th className="py-3.5 px-4 w-36">Time Segment</th>
                <th className="py-3.5 px-4">Scene Description</th>
                <th className="py-3.5 px-4">English Dialogue & Subtitles</th>
                <th className="py-3.5 px-4 w-48">Used Expressions</th>
                <th className="py-3.5 px-4 w-36">Source Movies</th>
                <th className="py-3.5 px-4 w-28">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#722F37]/12 text-base">
              {storyboard.beats.map((beat) => {
                const isRegenerating = regeneratingBeatId === beat.id;
                return (
                  <tr key={beat.id} className="align-top hover:bg-[#EFE7D8]/45 transition-colors">
                    <td className="py-4 px-4">
                      <div className="font-mono tabular-nums text-xs font-semibold text-[#722F37]">
                        {beat.timeRange}
                      </div>
                      <div className="font-display font-bold text-[#21191B]">
                        {beat.label}
                      </div>
                    </td>
                    <td className="py-4 px-4 text-[#21191B]/85 leading-relaxed">
                      <p>{beat.sceneDescription}</p>
                      {beat.visualDirection && (
                        <p className="mt-1.5 text-xs text-[#722F37] font-medium">
                          {beat.visualDirection.visualAccentNote}
                        </p>
                      )}
                    </td>
                    <td className="py-4 px-4 space-y-1.5 text-[#21191B] leading-relaxed">
                      {beat.dialogue.map((turn, ti) => (
                        <div key={ti}>
                          <span className="font-bold text-[#722F37]">
                            {turn.speaker}:{' '}
                          </span>
                          {renderHighlightedDialogue(
                            turn.line,
                            beat.usedExpressions,
                            beat.id
                          )}
                        </div>
                      ))}
                    </td>
                    <td className="py-4 px-4 text-sm font-semibold text-[#722F37]">
                      {beat.usedExpressions.map((u) => u.typedExpression).join(', ')}
                    </td>
                    <td className="py-4 px-4 text-sm text-[#21191B]/75">
                      {Array.from(
                        new Set(beat.usedExpressions.map((u) => u.sourceMovie))
                      ).join(', ')}
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setViewMode('cards');
                            startEditing(beat);
                          }}
                          className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full hover:bg-[#722F37]/12 text-[#21191B]"
                          title="Edit beat"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          disabled={isRegenerating}
                          onClick={() => onRegenerateBeatVisual(beat.id)}
                          className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full hover:bg-[#722F37]/12 text-[#722F37] disabled:opacity-50"
                          title="Regenerate visual presentation only"
                        >
                          {isRegenerating ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RefreshCw className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Navigation Capsule Buttons */}
      <div className="mt-8 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="liquid-glass-btn-secondary min-h-[50px] px-6 py-3 rounded-full text-base font-semibold flex items-center justify-center gap-2 active:scale-[0.98]"
        >
          <ArrowLeft className="w-5 h-5 text-[#E5C9AD]" />
          Back to Set the Scene
        </button>

        <button
          type="button"
          onClick={onProceedToVideo}
          className="liquid-glass-btn-primary min-h-[54px] px-8 py-3.5 rounded-full text-lg font-semibold active:scale-[0.98] flex items-center justify-center gap-2.5"
        >
          Lights, Camera, Action!
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </section>
  );
};
