import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Film } from 'lucide-react';
import { VISUAL_STYLE_OPTIONS } from '../data/courseExpressions';
import { SceneSetup, VisualStyleId } from '../types';

interface SceneStepProps {
  scene: SceneSetup;
  onChange: (next: SceneSetup) => void;
  onBack: () => void;
  onContinueToStoryboard: () => void;
}

export const SceneStep: React.FC<SceneStepProps> = ({
  scene,
  onChange,
  onBack,
  onContinueToStoryboard,
}) => {
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const updateField = <K extends keyof SceneSetup>(key: K, val: SceneSetup[K]) => {
    onChange({ ...scene, [key]: val });
  };

  return (
    <section className="cinema-enter max-w-5xl mx-auto px-4 sm:px-6 pt-8 pb-32 md:pb-16 overflow-x-hidden">
      <div className="mb-8">
        <p className="text-xs sm:text-sm font-medium tracking-wide text-[#E5C9AD] mb-2">
          Act II · Visual Direction
        </p>
        <h1 className="font-display text-3xl sm:text-5xl font-bold text-[#F5F0E6] tracking-tight text-balance">
          Set the Scene
        </h1>
        <p className="mt-3 text-base sm:text-lg text-[#F5F0E6]/80 max-w-2xl leading-relaxed">
          Review the setting and choose one of the four visual styles. Your style choice
          changes only the visual look, keeping the original script intact.
        </p>
      </div>

      {/* Story Setup Form in Frosted Warm Ivory */}
      <div className="liquid-glass-ivory text-[#21191B] rounded-[22px] p-5 sm:p-7 mb-9 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label
              htmlFor="scene-place"
              className="block text-sm font-semibold text-[#722F37] mb-2"
            >
              Place
            </label>
            <input
              id="scene-place"
              type="text"
              value={scene.place}
              onChange={(e) => updateField('place', e.target.value)}
              className="w-full min-h-[50px] px-4 py-3 rounded-2xl bg-white/85 border border-[#722F37]/18 text-base text-[#21191B] focus:outline-none focus:ring-2 focus:ring-[#722F37]/45 transition-all"
            />
          </div>

          <div>
            <label
              htmlFor="scene-characters"
              className="block text-sm font-semibold text-[#722F37] mb-2"
            >
              Characters
            </label>
            <input
              id="scene-characters"
              type="text"
              value={scene.characters}
              onChange={(e) => updateField('characters', e.target.value)}
              className="w-full min-h-[50px] px-4 py-3 rounded-2xl bg-white/85 border border-[#722F37]/18 text-base text-[#21191B] focus:outline-none focus:ring-2 focus:ring-[#722F37]/45 transition-all"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="scene-situation"
            className="block text-sm font-semibold text-[#722F37] mb-2"
          >
            Situation
          </label>
          <textarea
            id="scene-situation"
            rows={3}
            value={scene.situation}
            onChange={(e) => updateField('situation', e.target.value)}
            className="w-full px-4 py-3 rounded-2xl bg-white/85 border border-[#722F37]/18 text-base text-[#21191B] focus:outline-none focus:ring-2 focus:ring-[#722F37]/45 leading-relaxed transition-all"
          />
        </div>
      </div>

      {/* Visual Style Menu: 4 Minimal Liquid Glass Cards (Container-Responsive) */}
      <div className="mb-9 @container">
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 mb-4">
          <h2 className="font-display text-2xl sm:text-3xl font-bold text-[#F5F0E6]">
            Visual Style
          </h2>
          <span className="text-sm text-[#E5C9AD]">
            Consistent across all four beats
          </span>
        </div>

        <div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-5 items-stretch">
          {VISUAL_STYLE_OPTIONS.map((option) => {
            const selected = scene.style === option.id;
            const imgFailed = Boolean(failedImages[option.id]);

            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => updateField('style', option.id as VisualStyleId)}
                className={`group w-full h-full flex flex-col text-left rounded-[20px] overflow-hidden liquid-glass-ivory text-[#21191B] transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#E5C9AD] ${
                  selected
                    ? 'ring-2 ring-[#E5C9AD] shadow-xl'
                    : 'hover:ring-1 hover:ring-[#E5C9AD]/70'
                }`}
              >
                <div
                  className="relative w-full bg-[#29151E] overflow-hidden shrink-0"
                  style={{ aspectRatio: '16 / 9' }}
                >
                  {!imgFailed ? (
                    <img
                      src={option.imageUrl}
                      alt={`${option.title} preview`}
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setFailedImages((prev) => ({ ...prev, [option.id]: true }))
                      }
                      className="w-full h-full block object-cover object-center group-hover:scale-[1.02] transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full bg-[#29151E] flex flex-col items-center justify-center p-6 text-center">
                      <Film className="w-8 h-8 text-[#E5C9AD] mb-2" />
                      <span className="font-semibold text-[#F5F0E6]">{option.title}</span>
                    </div>
                  )}

                  {selected && (
                    <div className="absolute top-3 right-3 px-3 py-1 rounded-full bg-[#722F37]/85 backdrop-blur-md border border-[#E5C9AD]/60 text-[#F5F0E6] text-xs font-semibold flex items-center gap-1.5 shadow-md">
                      <Check className="w-3.5 h-3.5 text-[#E5C9AD]" />
                      Selected
                    </div>
                  )}
                </div>

                <div className="px-5 py-4 border-t border-[#722F37]/12 flex items-center justify-between gap-2 min-w-0">
                  <h3 className="font-display text-lg sm:text-xl font-bold text-[#21191B] whitespace-nowrap truncate">
                    {option.title}
                  </h3>
                </div>
              </button>
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
          Back to Choose Your Lines
        </button>

        <button
          type="button"
          onClick={onContinueToStoryboard}
          className="liquid-glass-btn-primary min-h-[54px] px-8 py-3.5 rounded-full text-lg font-semibold active:scale-[0.98] flex items-center justify-center gap-2.5"
        >
          Continue to Storyboard
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </section>
  );
};
