import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Pin, Plus, Sparkles } from 'lucide-react';
import type { TaskDetail } from '../types';
import { FishboneWorkspace } from './FishboneWorkspace';

interface OneBigThingViewProps {
  tasks: TaskDetail[];
  onUpdated: (task: TaskDetail) => void;
  onSelectTaskDrawer: (taskId: string) => void;
  onOpenQuickAdd: () => void;
  onPrepareCheckout?: (
    taskId: string,
    artifactId: string,
    productUrl: string
  ) => void;
}

export function OneBigThingView({
  tasks,
  onUpdated,
  onSelectTaskDrawer,
  onOpenQuickAdd,
  onPrepareCheckout,
}: OneBigThingViewProps) {
  const activeTasks = useMemo(
    () => tasks.filter((t) => t.columnStatus !== 'done'),
    [tasks]
  );

  const defaultTask = useMemo(() => {
    return (
      tasks.find((t) => t.fishbone?.isPinnedBigThing) ??
      activeTasks.find((t) => (t.fishbone?.bones.length ?? 0) > 0) ??
      activeTasks[0] ??
      tasks[0] ??
      null
    );
  }, [tasks, activeTasks]);

  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(
    defaultTask?.id ?? null
  );

  useEffect(() => {
    if (defaultTask && (!focusedTaskId || !tasks.some((t) => t.id === focusedTaskId))) {
      setFocusedTaskId(defaultTask.id);
    }
  }, [defaultTask, focusedTaskId, tasks]);

  // Also switch automatically if a task is newly pinned as One Big Thing
  const pinnedTaskId = useMemo(
    () => tasks.find((t) => t.fishbone?.isPinnedBigThing)?.id ?? null,
    [tasks]
  );
  useEffect(() => {
    if (pinnedTaskId) {
      setFocusedTaskId(pinnedTaskId);
    }
  }, [pinnedTaskId]);

  const focusedTask = useMemo(
    () => tasks.find((t) => t.id === focusedTaskId) ?? defaultTask,
    [tasks, focusedTaskId, defaultTask]
  );

  if (!focusedTask) {
    return (
      <div className="rounded-xl border border-[#DDD6C7] bg-[#FDFCF9] p-10 text-center space-y-4">
        <div className="font-mono-spec text-[10px] tracking-[0.18em] uppercase text-[#8E897E]">
          11 FRIEND NOTEBOOKS · TODAY&apos;S ONE BIG THING
        </div>
        <h2 className="font-serif-editorial text-2xl text-[#1F1E1B]">
          Brak zadań do rozpisania na Rybią Ość
        </h2>
        <p className="text-xs text-[#5C584F] max-w-md mx-auto">
          Dodaj swoje główne wyzwanie dnia, a potem rozbij je wspólnie z AI na
          kręgosłup, ości decyzyjne i artefakty.
        </p>
        <button
          type="button"
          onClick={onOpenQuickAdd}
          className="inline-flex items-center gap-1.5 rounded-md bg-[#1F1E1B] hover:bg-[#34322D] px-4 py-2 text-xs font-medium text-[#FAF8F3] transition"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Dodaj główne zadanie</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Top Task Switcher Bar (Pinned + Fishbone tasks + Active tasks) */}
      <div className="rounded-xl border border-[#DDD6C7] bg-[#FDFCF9] p-4 shadow-[0_1px_4px_rgba(31,30,27,0.03)] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono-spec text-[10px] tracking-[0.16em] uppercase text-[#8E897E] mr-1">
            WYBIERZ SPRAWĘ NA ARKUSZ:
          </span>
          {(activeTasks.length > 0 ? activeTasks : tasks)
            .slice(0, 8)
            .map((t) => {
              const isFocused = t.id === focusedTask.id;
              const isPinned = Boolean(t.fishbone?.isPinnedBigThing);
              const boneCount = t.fishbone?.bones.length ?? 0;
              const doneBones =
                t.fishbone?.bones.filter((b) => b.status === 'done').length ??
                0;

              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setFocusedTaskId(t.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition max-w-[260px] ${
                    isFocused
                      ? 'border-[#1F1E1B] bg-[#1F1E1B] text-[#FAF8F3] font-medium shadow-sm'
                      : isPinned
                        ? 'border-[#C6D1BC] bg-[#E3EBDC] text-[#1F261D] hover:bg-[#D5E2C8]'
                        : 'border-[#DDD6C7] bg-[#FAF8F3] text-[#36332D] hover:bg-[#EFECE3]'
                  }`}
                >
                  {isPinned && <Pin className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{t.title}</span>
                  {boneCount > 0 && (
                    <span
                      className={`font-mono-spec text-[9.5px] px-1 rounded ${
                        isFocused
                          ? 'bg-[#FAF8F3]/20 text-[#FAF8F3]'
                          : 'bg-[#EFECE3] text-[#5C584F]'
                      }`}
                    >
                      {doneBones}/{boneCount}
                    </span>
                  )}
                </button>
              );
            })}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onSelectTaskDrawer(focusedTask.id)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#DDD6C7] bg-[#FAF8F3] hover:bg-[#EFECE3] px-3 py-1.5 text-xs text-[#36332D] transition"
          >
            <MessageSquare className="h-3.5 w-3.5 text-[#4A7C6A]" />
            <span>Otwórz czat i szczegóły ({focusedTask.messages.length})</span>
          </button>
        </div>
      </div>

      {/* Full-Page Fishbone Spread */}
      <FishboneWorkspace
        task={focusedTask}
        mode="fullpage"
        onUpdated={onUpdated}
        onPrepareCheckout={onPrepareCheckout}
      />
    </div>
  );
}
