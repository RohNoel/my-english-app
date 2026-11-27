import React from 'react';
import {
  Clapperboard,
  Film,
  Palette,
  Play,
  Ticket,
} from 'lucide-react';
import { AppStep } from '../types';

interface TopBarProps {
  currentStep: AppStep;
  onSelectStep: (step: AppStep) => void;
  canAccessScene: boolean;
  canAccessStoryboard: boolean;
  canAccessVideo: boolean;
  canAccessFinal: boolean;
  onPrimaryAction: () => void;
  primaryActionLabel: string;
  primaryActionDisabled?: boolean;
}

const STEPS: Array<{
  id: AppStep;
  label: string;
  shortLabel: string;
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}> = [
  { id: 'expressions', label: '1. Choose Lines', shortLabel: 'Lines', Icon: Ticket },
  { id: 'scene', label: '2. Set Scene', shortLabel: 'Scene', Icon: Palette },
  { id: 'storyboard', label: '3. Storyboard', shortLabel: 'Script', Icon: Clapperboard },
  { id: 'video', label: '4. Production', shortLabel: 'Film', Icon: Film },
  { id: 'final', label: '5. Screening', shortLabel: 'Watch', Icon: Play },
];

export const TopBar: React.FC<TopBarProps> = ({
  currentStep,
  onSelectStep,
  canAccessScene,
  canAccessStoryboard,
  canAccessVideo,
  canAccessFinal,
  onPrimaryAction,
  primaryActionLabel,
  primaryActionDisabled,
}) => {
  const isAccessible = (id: AppStep) => {
    if (id === 'expressions') return true;
    if (id === 'scene') return canAccessScene;
    if (id === 'storyboard') return canAccessStoryboard;
    if (id === 'video') return canAccessVideo;
    if (id === 'final') return canAccessFinal;
    return false;
  };

  return (
    <>
      <header className="sticky top-0 z-30 liquid-glass-bar">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3 sm:gap-6">
          {/* Zone 1: Brand wordmark with subtle film icon */}
          <button
            type="button"
            onClick={() => onSelectStep('expressions')}
            className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#E5C9AD] rounded-full py-1 px-1"
          >
            <Film className="w-5 h-5 text-[#E5C9AD] shrink-0" aria-hidden="true" />
            <span className="font-display text-2xl font-bold tracking-tight text-[#F5F0E6]">
              CineLingo
            </span>
          </button>

          {/* Zone 2: Clean single-line text step links */}
          <nav
            aria-label="Workflow steps"
            className="hidden md:flex items-center gap-5 lg:gap-7 text-sm font-medium"
          >
            {STEPS.map((step) => {
              const active = currentStep === step.id;
              const enabled = isAccessible(step.id);
              return (
                <button
                  key={step.id}
                  type="button"
                  disabled={!enabled}
                  onClick={() => enabled && onSelectStep(step.id)}
                  className={`whitespace-nowrap shrink-0 py-1.5 border-b-2 transition-colors duration-200 ${
                    active
                      ? 'border-[#E5C9AD] text-[#F5F0E6] font-semibold'
                      : enabled
                      ? 'border-transparent text-[#F5F0E6]/75 hover:text-[#F5F0E6] hover:border-[#E5C9AD]/45'
                      : 'border-transparent text-[#F5F0E6]/30 cursor-not-allowed'
                  }`}
                >
                  {step.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single primary contextual capsule CTA */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              disabled={primaryActionDisabled}
              onClick={onPrimaryAction}
              className="liquid-glass-btn-primary min-h-[40px] px-5 py-2 rounded-full text-sm font-semibold active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
            >
              {primaryActionLabel}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Floating Liquid Glass Capsule Bar */}
      <nav
        aria-label="Mobile workflow steps"
        className="md:hidden fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 mx-auto max-w-md z-40 liquid-glass-capsule rounded-full p-1.5"
      >
        <div className="grid grid-cols-5 gap-1">
          {STEPS.map((step) => {
            const active = currentStep === step.id;
            const enabled = isAccessible(step.id);
            const StepIcon = step.Icon;
            return (
              <button
                key={step.id}
                type="button"
                disabled={!enabled}
                onClick={() => enabled && onSelectStep(step.id)}
                className={`min-h-[44px] rounded-full px-1 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-all duration-200 whitespace-nowrap ${
                  active
                    ? 'bg-[#F5F0E6]/20 text-[#F5F0E6] font-semibold border border-[#E5C9AD]/35 shadow-sm'
                    : enabled
                    ? 'text-[#F5F0E6]/78 hover:bg-[#F5F0E6]/10 hover:text-[#F5F0E6] border border-transparent'
                    : 'text-[#F5F0E6]/30 border border-transparent cursor-not-allowed'
                }`}
              >
                <StepIcon className="w-3.5 h-3.5 shrink-0" aria-hidden={true} />
                <span className="truncate max-w-full">{step.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};
