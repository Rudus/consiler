import { useEffect, useRef, useState } from 'react';
import { GitBranch, LayoutGrid, LogOut, Package, Plus } from 'lucide-react';
import type { AuthState } from '../types';
import type { DashboardViewMode } from './Header';
import { NotebookMark } from './NotebookMark';

interface NotebookSpineProps {
  auth: AuthState;
  sseConnected: boolean;
  viewMode: DashboardViewMode;
  artifactCount: number;
  fishboneCount: number;
  onViewModeChange: (mode: DashboardViewMode) => void;
  onOpenQuickAdd: () => void;
  onLogout: () => void;
}

export function NotebookSpine({
  auth,
  sseConnected,
  viewMode,
  artifactCount,
  fishboneCount,
  onViewModeChange,
  onOpenQuickAdd,
  onLogout,
}: NotebookSpineProps) {
  const [statusOpen, setStatusOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!statusOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setStatusOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [statusOpen]);

  return (
    <aside className="hidden md:flex w-14 shrink-0 bg-[#FAF8F3] border-r border-[#DDD6C7] relative flex-col items-center justify-between py-5 select-none z-30">
      {/* Subtle MD-style binding tape texture along left edge */}
      <div className="absolute inset-y-0 left-0 w-1.5 spine-binding-strip border-r border-[#EAE4D7]" />

      {/* Top: Brand emblem + vertical sketchbook title */}
      <div className="flex flex-col items-center gap-4 pl-1">
        <button
          type="button"
          onClick={() => onViewModeChange('board')}
          title="Consiler — Tablica"
          className="h-8 w-8 rounded-md flex items-center justify-center text-[#1F1E1B] hover:bg-[#EFECE3] transition"
        >
          <NotebookMark className="h-5 w-5" />
        </button>

        <div
          className="font-mono-spec text-[9.5px] tracking-[0.22em] uppercase text-[#8E897E] rotate-180"
          style={{ writingMode: 'vertical-rl' }}
        >
          CONSILIER · A5
        </div>
      </div>

      {/* Middle: Navigation & Quick Add */}
      <div className="flex flex-col items-center gap-2 pl-1">
        <button
          type="button"
          onClick={() => onViewModeChange('board')}
          title="Tablica zadań"
          className={`h-9 w-9 rounded-md flex items-center justify-center transition ${
            viewMode === 'board'
              ? 'bg-[#E3EBDC] text-[#1F261D] border border-[#C6D1BC]'
              : 'text-[#7A7468] hover:text-[#1F1E1B] hover:bg-[#EFECE3]'
          }`}
        >
          <LayoutGrid className="h-4 w-4" strokeWidth={1.65} />
        </button>

        <button
          type="button"
          onClick={() => onViewModeChange('fishbone')}
          title="Today's One Big Thing — Graf Rybiej Ości"
          className={`relative h-9 w-9 rounded-md flex items-center justify-center transition ${
            viewMode === 'fishbone'
              ? 'bg-[#EFE6D2] text-[#2B251A] border border-[#D6C9AD]'
              : 'text-[#7A7468] hover:text-[#1F1E1B] hover:bg-[#EFECE3]'
          }`}
        >
          <GitBranch className="h-4 w-4" strokeWidth={1.65} />
          {fishboneCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-[#9C6B30] text-[#FAF8F3] font-mono-spec text-[9px] flex items-center justify-center">
              {fishboneCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => onViewModeChange('artifacts')}
          title="Artefakty"
          className={`relative h-9 w-9 rounded-md flex items-center justify-center transition ${
            viewMode === 'artifacts'
              ? 'bg-[#DFE8EC] text-[#1D2529] border border-[#C2CFD6]'
              : 'text-[#7A7468] hover:text-[#1F1E1B] hover:bg-[#EFECE3]'
          }`}
        >
          <Package className="h-4 w-4" strokeWidth={1.65} />
          {artifactCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-[#4A7C6A] text-[#FAF8F3] font-mono-spec text-[9px] flex items-center justify-center">
              {artifactCount}
            </span>
          )}
        </button>

        <div className="w-5 h-px bg-[#DDD6C7] my-1" />

        <button
          type="button"
          onClick={onOpenQuickAdd}
          title="Dodaj zadanie (lub wklej Ctrl+V)"
          className="h-9 w-9 rounded-md border border-[#CFC8B8] bg-[#FDFCF9] hover:border-[#4A7C6A] hover:text-[#4A7C6A] text-[#1F1E1B] flex items-center justify-center transition shadow-[0_1px_2px_rgba(31,30,27,0.04)]"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      {/* Bottom: Quiet connection & system popover */}
      <div className="relative pl-1" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setStatusOpen((v) => !v)}
          title={sseConnected ? 'Połączono na żywo' : 'Łączenie...'}
          className="h-8 w-8 rounded-md flex items-center justify-center hover:bg-[#EFECE3] transition"
        >
          <span
            className={`h-2 w-2 rounded-full ring-2 ring-[#FAF8F3] ${
              sseConnected ? 'bg-[#4A7C6A]' : 'bg-[#9C6B30] animate-pulse'
            }`}
          />
        </button>

        {statusOpen && (
          <div className="absolute left-12 bottom-0 w-60 rounded-lg border border-[#DDD6C7] bg-[#FDFCF9] p-3.5 shadow-[0_6px_24px_rgba(31,30,27,0.08)] space-y-2.5 text-xs">
            <div className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#8E897E] border-b border-[#EAE4D7] pb-1.5">
              Status systemu
            </div>
            <div className="flex items-center justify-between text-[#36332D]">
              <span>Strumień na żywo</span>
              <span
                className={`font-mono-spec text-[11px] ${
                  sseConnected ? 'text-[#4A7C6A]' : 'text-[#9C6B30]'
                }`}
              >
                {sseConnected ? 'ONLINE' : 'CONNECTING'}
              </span>
            </div>
            <div className="flex items-center justify-between text-[#36332D]">
              <span>Discord 1:1</span>
              <span
                className={`font-mono-spec text-[11px] ${
                  auth.discordEnabled ? 'text-[#4B6E84]' : 'text-[#8E897E]'
                }`}
              >
                {auth.discordEnabled ? 'AKTYWNY' : 'OFFLINE'}
              </span>
            </div>
            <div className="flex items-center justify-between text-[#36332D]">
              <span>Kalendarz „{auth.calendarName}”</span>
              <span
                className={`font-mono-spec text-[11px] ${
                  auth.calendarEnabled ? 'text-[#4A7C6A]' : 'text-[#8E897E]'
                }`}
              >
                {auth.calendarEnabled ? 'AKTYWNY' : 'OFFLINE'}
              </span>
            </div>
            <p className="text-[11px] text-[#7A7468] pt-1 border-t border-[#EAE4D7] leading-relaxed">
              Wklej zrzut ekranu skrótem{' '}
              <kbd className="font-mono-spec px-1 py-0.5 rounded bg-[#EFECE3] border border-[#DDD6C7] text-[#1F1E1B] text-[10px]">
                Ctrl+V
              </kbd>{' '}
              w dowolnym miejscu tablicy.
            </p>
            {auth.authRequired && (
              <button
                type="button"
                onClick={onLogout}
                className="w-full mt-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-[#DDD6C7] bg-[#FAF8F3] hover:bg-[#EFECE3] py-1.5 text-[11px] text-[#5C584F] hover:text-[#1F1E1B] transition"
              >
                <LogOut className="h-3 w-3" />
                <span>Wyloguj</span>
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
