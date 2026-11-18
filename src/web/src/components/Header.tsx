import { LogOut, MapPin, Plus, Search, X } from 'lucide-react';
import type { AuthState } from '../types';
import { NotebookMark } from './NotebookMark';
import { PaperTab } from './PaperTabs';

export type DashboardViewMode = 'board' | 'fishbone' | 'artifacts';

interface HeaderProps {
  auth: AuthState;
  sseConnected: boolean;
  viewMode: DashboardViewMode;
  activeCount: number;
  artifactCount: number;
  fishboneCount: number;
  shippingConfigured: boolean;
  search: string;
  onViewModeChange: (mode: DashboardViewMode) => void;
  onSearchChange: (val: string) => void;
  onOpenShippingProfile: () => void;
  onOpenQuickAdd: () => void;
  onLogout: () => void;
}

export function Header({
  auth,
  sseConnected,
  viewMode,
  activeCount,
  artifactCount,
  fishboneCount,
  shippingConfigured,
  search,
  onViewModeChange,
  onSearchChange,
  onOpenShippingProfile,
  onOpenQuickAdd,
  onLogout,
}: HeaderProps) {
  const todayLabel = new Intl.DateTimeFormat('pl-PL', {
    day: '2-digit',
    month: 'short',
  })
    .format(new Date())
    .toUpperCase();

  return (
    <header className="sticky top-0 z-20 border-b border-[#DDD6C7]/90 bg-[#F4F1EA]/90 backdrop-blur-sm px-4 sm:px-8 pt-3.5">
      <div className="max-w-[1520px] mx-auto flex flex-wrap items-end justify-between gap-4">
        {/* Left: Editorial Heading & Spec Eyebrow */}
        <div className="flex items-center gap-3 pb-3">
          <div className="md:hidden h-8 w-8 rounded-md border border-[#DDD6C7] bg-[#FAF8F3] flex items-center justify-center text-[#1F1E1B]">
            <NotebookMark className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2 font-mono-spec text-[10px] tracking-[0.16em] uppercase text-[#8E897E]">
              <span>{todayLabel}</span>
              <span>·</span>
              <span>
                {viewMode === 'board'
                  ? `${String(activeCount).padStart(2, '0')} AKTYWNYCH`
                  : viewMode === 'fishbone'
                    ? 'ANTI-PARALYSIS · CO-OP AI'
                    : `${String(artifactCount).padStart(2, '0')} ARTEFAKTÓW`}
              </span>
              <span
                className={`md:hidden inline-block h-1.5 w-1.5 rounded-full ${
                  sseConnected ? 'bg-[#4A7C6A]' : 'bg-[#9C6B30]'
                }`}
              />
            </div>
            <h1 className="font-serif-editorial text-2xl sm:text-[27px] font-normal tracking-[-0.015em] text-[#1F1E1B] leading-tight">
              {viewMode === 'board'
                ? 'Tablica zadań'
                : viewMode === 'fishbone'
                  ? "Today's One Big Thing · Rybia Ość"
                  : 'Zebrane artefakty'}
            </h1>
          </div>
        </div>

        {/* Right: Pastel Notebook Index Tabs + Underline Search + Ink Action */}
        <div className="flex items-end gap-4 sm:gap-5 flex-1 sm:flex-initial justify-end flex-wrap">
          <nav className="flex items-end gap-1">
            <PaperTab
              active={viewMode === 'board'}
              tone="sage"
              onClick={() => onViewModeChange('board')}
            >
              <span>Tablica</span>
            </PaperTab>
            <PaperTab
              active={viewMode === 'fishbone'}
              tone="ochre"
              onClick={() => onViewModeChange('fishbone')}
            >
              <span>🦴 One Big Thing</span>
              {fishboneCount > 0 && (
                <span className="opacity-75">{fishboneCount}</span>
              )}
            </PaperTab>
            <PaperTab
              active={viewMode === 'artifacts'}
              tone="blue"
              onClick={() => onViewModeChange('artifacts')}
            >
              <span>Artefakty</span>
              {artifactCount > 0 && (
                <span className="opacity-75">{artifactCount}</span>
              )}
            </PaperTab>
          </nav>

          {/* Hairline underline search */}
          <div className="relative w-40 sm:w-52 pb-3">
            <Search
              className="absolute left-0 top-[9px] h-3.5 w-3.5 text-[#8E897E]"
              strokeWidth={1.75}
            />
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={
                viewMode === 'artifacts' ? 'Szukaj...' : 'Filtruj zadania...'
              }
              className="w-full border-b border-[#CFC8B8] focus:border-[#4A7C6A] bg-transparent pl-5 pr-5 py-1 text-xs text-[#1F1E1B] placeholder:text-[#9A9488] focus:outline-none transition"
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="absolute right-0 top-[9px] text-[#8E897E] hover:text-[#1F1E1B]"
                title="Wyczyść"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 pb-2.5 shrink-0">
            <button
              type="button"
              onClick={onOpenShippingProfile}
              title="Ustaw dane dostawy do półautomatycznych zakupów"
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition shrink-0 ${
                shippingConfigured
                  ? 'border-[#C6D1BC] bg-[#E3EBDC] text-[#244337] hover:bg-[#D5E2C8]'
                  : 'border-[#DDD6C7] bg-[#FAF8F3] text-[#5C584F] hover:bg-[#EFECE3]'
              }`}
            >
              <MapPin className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Dane dostawy</span>
            </button>

            <button
              type="button"
              onClick={onOpenQuickAdd}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#1F1E1B] hover:bg-[#34322D] px-3 py-1.5 text-xs font-medium text-[#FAF8F3] transition shadow-[0_1px_2px_rgba(31,30,27,0.12)] shrink-0"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              <span>Nowe zadanie</span>
            </button>

            {auth.authRequired && (
              <button
                type="button"
                onClick={onLogout}
                title="Wyloguj"
                className="md:hidden rounded-md border border-[#DDD6C7] bg-[#FAF8F3] p-1.5 text-[#5C584F] hover:text-[#1F1E1B] transition"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
