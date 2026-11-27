import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Film,
  Search,
  Ticket,
  Trash2,
} from 'lucide-react';
import {
  FIXED_EXPRESSIONS,
  searchFixedExpressions,
} from '../data/courseExpressions';
import { CourseExpression } from '../types';

interface ExpressionStepProps {
  selectedExpressions: CourseExpression[];
  onChange: (next: CourseExpression[]) => void;
  onNext: () => void;
}

export const ExpressionStep: React.FC<ExpressionStepProps> = ({
  selectedExpressions,
  onChange,
  onNext,
}) => {
  const [query, setQuery] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const selectedIds = useMemo(
    () => new Set(selectedExpressions.map((e) => e.id)),
    [selectedExpressions]
  );

  const searchResults = useMemo(
    () => searchFixedExpressions(query),
    [query]
  );

  const allFiveSelected = selectedExpressions.length === FIXED_EXPRESSIONS.length;

  const handleSelect = (item: CourseExpression) => {
    if (selectedIds.has(item.id)) {
      return;
    }
    onChange([...selectedExpressions, item]);
    setQuery('');
    setIsDropdownOpen(false);
  };

  const handleRemove = (id: string) => {
    onChange(selectedExpressions.filter((e) => e.id !== id));
  };

  return (
    <section className="cinema-enter max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-32 md:pb-16 overflow-x-hidden">
      {/* Studio Heading & Tagline */}
      <div className="mb-8">
        <p className="text-xs sm:text-sm font-medium tracking-wide text-[#E5C9AD] mb-2">
          From movie lines to your own scenes.
        </p>
        <h1 className="font-display text-3xl sm:text-5xl font-bold text-[#F5F0E6] tracking-tight text-balance">
          Choose Your Lines
        </h1>
        <p className="mt-3 text-base sm:text-lg text-[#F5F0E6]/80 max-w-2xl leading-relaxed">
          Search by English expression, Korean meaning, or source movie in the search bar
          below. Collect all five cinema lines to open your scene setup.
        </p>
      </div>

      {/* Unified Single Search Bar in Translucent Liquid Glass */}
      <div className="relative mb-6">
        <label htmlFor="unified-expression-search" className="sr-only">
          Search expressions by English, Korean meaning, or movie title
        </label>
        <div className="relative">
          <Search className="w-5 h-5 text-[#722F37] absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            id="unified-expression-search"
            type="text"
            value={query}
            onFocus={() => setIsDropdownOpen(true)}
            onBlur={() => {
              setTimeout(() => setIsDropdownOpen(false), 180);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setIsDropdownOpen(true);
            }}
            placeholder='Search English, Korean, or movie (e.g. "I was", "긴장", "Notting", "Inside Out")'
            className="liquid-glass-input w-full min-h-[56px] pl-13 pr-5 py-3.5 rounded-full text-base sm:text-lg text-[#21191B] placeholder:text-[#21191B]/48 focus:outline-none focus:ring-2 focus:ring-[#E5C9AD]/70 transition-all duration-200"
          />
        </div>

        {/* Frosted-Glass Autocomplete Dropdown */}
        {isDropdownOpen && (
          <div
            role="listbox"
            aria-label="Matching expressions"
            className="cinema-enter absolute left-0 right-0 top-full mt-2.5 z-30 liquid-glass-ivory rounded-[20px] overflow-hidden max-h-80 overflow-y-auto"
          >
            {searchResults.length === 0 ? (
              <div className="px-5 py-6 text-center text-base font-medium text-[#21191B]/70">
                No matching expressions found.
              </div>
            ) : (
              searchResults.map((item) => {
                const isSelected = selectedIds.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={isSelected}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelect(item);
                    }}
                    className={`w-full text-left px-5 py-4 border-b border-[#C4A574]/30 last:border-b-0 flex items-center justify-between gap-4 transition-colors ${
                      isSelected
                        ? 'bg-[#21191B]/5 text-[#21191B]/45 cursor-not-allowed'
                        : 'hover:bg-[#C4A574]/20 text-[#21191B]'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-base sm:text-lg font-bold break-words">{item.english}</p>
                      <p className="text-sm sm:text-base text-[#21191B]/75 mt-0.5 break-words">
                        {item.korean}{' '}
                        <span aria-hidden="true" className="text-[#C4A574] mx-1">
                          ·
                        </span>{' '}
                        <span className="font-semibold text-[#722F37]">
                          {item.movie}
                        </span>
                      </p>
                    </div>
                    {isSelected ? (
                      <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-[#722F37] shrink-0">
                        <Check className="w-4 h-4" />
                        Selected
                      </span>
                    ) : (
                      <span className="text-xs sm:text-sm font-semibold text-[#722F37] shrink-0">
                        Select
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Requirement Progress Notice */}
      <div className="mb-7">
        {!allFiveSelected ? (
          <div
            role="status"
            className="liquid-glass-panel flex items-start gap-3 p-4 sm:p-5 rounded-[20px] text-[#F5F0E6]"
          >
            <AlertCircle className="w-5 h-5 text-[#E5C9AD] shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-base tabular-nums">
                {selectedExpressions.length} of 5 required expressions selected
              </p>
              <p className="text-sm text-[#F5F0E6]/75 mt-0.5">
                Select all 5 expressions from the search bar above to continue to Set the Scene.
              </p>
            </div>
          </div>
        ) : (
          <div
            role="status"
            className="liquid-glass-ivory flex items-center gap-3 p-4 sm:p-5 rounded-[20px] text-[#21191B]"
          >
            <CheckCircle2 className="w-5 h-5 text-[#722F37] shrink-0" />
            <p className="font-semibold text-base">
              All 5 required expressions collected. Ready for Set the Scene.
            </p>
          </div>
        )}
      </div>

      {/* Selected Expressions as Frosted Cinema Ticket Cards */}
      <div className="space-y-3.5 mb-8">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl sm:text-2xl font-bold text-[#F5F0E6] flex items-center gap-2">
            <Ticket className="w-5 h-5 text-[#E5C9AD]" aria-hidden="true" />
            Selected Lines ({selectedExpressions.length}/5)
          </h2>
        </div>

        {selectedExpressions.length === 0 ? (
          <div className="liquid-glass-panel p-8 rounded-[20px] text-center text-base text-[#F5F0E6]/75">
            No lines selected yet. Use the search bar above to pick all five expressions.
          </div>
        ) : (
          selectedExpressions.map((item, idx) => (
            <div
              key={item.id}
              className="liquid-glass-ivory relative text-[#21191B] rounded-[20px] overflow-hidden flex flex-col sm:flex-row sm:items-stretch justify-between transition-transform duration-200"
            >
              {/* Left Vintage Ticket Stub */}
              <div className="sm:w-44 px-5 py-3.5 sm:py-5 bg-[#EFE7D8]/70 border-b sm:border-b-0 sm:border-r border-dashed border-[#722F37]/20 flex sm:flex-col justify-between items-center sm:items-start gap-2 shrink-0">
                <span className="font-mono tabular-nums text-xs font-semibold text-[#722F37]">
                  Ticket 0{idx + 1}
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#21191B]/85">
                  <Film className="w-3.5 h-3.5 text-[#722F37]" aria-hidden="true" />
                  {item.movie}
                </span>
              </div>

              {/* Ticket Body */}
              <div className="flex-1 min-w-0 px-5 py-4 sm:py-5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-lg sm:text-xl font-bold text-[#21191B] break-words">
                    {item.english}
                  </p>
                  <p className="text-base text-[#21191B]/80 mt-1 break-words">{item.korean}</p>
                </div>

                <button
                  type="button"
                  aria-label={`Remove ${item.english}`}
                  onClick={() => handleRemove(item.id)}
                  className="min-h-[44px] min-w-[44px] rounded-full text-[#21191B]/55 hover:text-[#722F37] hover:bg-[#722F37]/10 flex items-center justify-center transition-colors shrink-0"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Primary Wine Red Glass Capsule CTA */}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!allFiveSelected}
          onClick={onNext}
          className="liquid-glass-btn-primary w-full sm:w-auto min-h-[54px] px-8 py-3.5 rounded-full text-lg font-semibold active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
        >
          Next: Set the Scene
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </section>
  );
};
