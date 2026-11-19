import React from 'react';
import {
  AlertCircle,
  Bell,
  Calendar,
  CalendarCheck,
  Check,
  CheckSquare,
  Loader2,
  MessageSquare,
  Package,
  Sparkles,
} from 'lucide-react';
import type { TaskDetail, TaskPriority } from '../types';

const PRIORITY_STYLE: Record<
  TaskPriority,
  { label: string; dot: string; text?: string }
> = {
  low: {
    label: 'Niski',
    dot: 'bg-[#B5AFA2]',
  },
  medium: {
    label: 'Średni',
    dot: 'bg-[#4B6E84]',
  },
  high: {
    label: 'Ważne',
    dot: 'bg-[#9C6B30]',
    text: 'text-[#8C5E28]',
  },
  urgent: {
    label: 'Pilne',
    dot: 'bg-[#A94B3E]',
    text: 'text-[#A94B3E]',
  },
};

function formatShortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('pl-PL', {
    day: 'numeric',
    month: 'short',
  }).format(d);
}

interface TaskCardProps {
  task: TaskDetail;
  selected: boolean;
  onSelect: () => void;
  onQuickDone: (e: React.MouseEvent) => void;
}

export function TaskCard({
  task,
  selected,
  onSelect,
  onQuickDone,
}: TaskCardProps) {
  const firstImg = task.attachments.find((a) =>
    a.mimeType.startsWith('image/')
  );
  const completedCount = task.checklist.filter((c) => c.completed).length;
  const prio = PRIORITY_STYLE[task.priority] ?? PRIORITY_STYLE.medium;
  const isDone = task.columnStatus === 'done';
  const isOverdue =
    task.dueAt &&
    !isDone &&
    new Date(task.dueAt).getTime() < Date.now();

  const boneCount = task.fishbone?.bones.length ?? 0;
  const doneBoneCount =
    task.fishbone?.bones.filter((b) => b.status === 'done').length ?? 0;

  const hasMeta =
    boneCount > 0 ||
    (task.artifacts?.length ?? 0) > 0 ||
    Boolean(task.researchReport) ||
    Boolean(task.googleEventId) ||
    Boolean(task.dueAt) ||
    Boolean(task.reminderAt && !task.reminderSentAt) ||
    task.checklist.length > 0 ||
    task.messages.length > 0;

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onSelect}
      className={`group cursor-pointer rounded-lg border px-3.5 py-3 transition-all ${
        selected
          ? 'border-[#4A7C6A] bg-[#FDFCF9] ring-1 ring-[#4A7C6A]/25 shadow-[0_3px_12px_rgba(31,30,27,0.06)]'
          : 'border-[#DFD9CC] bg-[#FAF8F3] hover:border-[#BFB6A4] hover:bg-[#FDFCF9] shadow-[0_1px_2px_rgba(31,30,27,0.03)] hover:shadow-[0_3px_10px_rgba(31,30,27,0.05)]'
      }`}
    >
      {/* Top micro-row: priority dot + tracked category + hover check */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${prio.dot}`} />
          <span className="font-mono-spec text-[9.5px] tracking-[0.14em] uppercase text-[#8E897E] truncate">
            {task.category}
          </span>
          {prio.text && (
            <span
              className={`font-mono-spec text-[9.5px] tracking-[0.12em] uppercase font-medium ${prio.text}`}
            >
              · {prio.label}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onQuickDone}
          title={isDone ? 'Przywróć do zrobienia' : 'Oznacz jako zrobione'}
          className={`h-5 w-5 rounded-full border flex items-center justify-center transition shrink-0 ${
            isDone
              ? 'border-[#4A7C6A] bg-[#4A7C6A] text-[#FAF8F3]'
              : 'border-[#CFC8B8] text-transparent opacity-0 group-hover:opacity-100 hover:border-[#4A7C6A] hover:text-[#4A7C6A]'
          }`}
        >
          <Check className="h-3 w-3" strokeWidth={2.5} />
        </button>
      </div>

      {/* Main row: Title + concise summary + optional compact framed thumbnail */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3
            className={`text-[13.5px] font-medium leading-snug ${
              isDone ? 'line-through text-[#8E897E]' : 'text-[#1F1E1B]'
            }`}
          >
            {task.title}
          </h3>

          {(task.aiSummary || task.userPrompt) && (
            <p className="text-[12px] text-[#6B665C] line-clamp-2 mt-1 leading-relaxed">
              {task.aiSummary || task.userPrompt}
            </p>
          )}
        </div>

        {firstImg && (
          <div className="w-12 h-12 rounded border border-[#DDD6C7] bg-[#EFECE3] overflow-hidden shrink-0 mt-0.5">
            <img
              src={`/api/uploads/${firstImg.filename}`}
              alt={firstImg.originalName}
              loading="lazy"
              className="w-full h-full object-cover"
            />
          </div>
        )}
      </div>

      {/* Subtle left-hairline state note */}
      {task.columnStatus === 'ai_processing' && (
        <div className="mt-2.5 flex items-center gap-1.5 border-l-2 border-[#4A7C6A] pl-2 text-[11px] text-[#3D6B5B]">
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
          <span>Asystent analizuje w tle…</span>
        </div>
      )}

      {task.needsClarification && (
        <div className="mt-2.5 flex items-center gap-1.5 border-l-2 border-[#9C6B30] pl-2 text-[11px] text-[#8C5E28]">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span>Wymaga doprecyzowania</span>
        </div>
      )}

      {/* Quiet hairline metadata footer */}
      {hasMeta && (
        <div className="mt-2.5 pt-2 border-t border-[#EAE4D7] flex flex-wrap items-center gap-x-3 gap-y-1 font-mono-spec text-[10px] text-[#7A7468]">
          {boneCount > 0 && (
            <span
              title="Graf Rybiej Ości (ukończone ości)"
              className="inline-flex items-center gap-1 text-[#9C6B30] font-medium"
            >
              <span>🦴</span>
              <span>
                {doneBoneCount}/{boneCount}
              </span>
            </span>
          )}
          {(task.artifacts?.length ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 text-[#4A7C6A]">
              <Package className="h-3 w-3" strokeWidth={1.75} />
              {task.artifacts.length}
            </span>
          )}
          {task.researchReport && (
            <span className="inline-flex items-center gap-1 text-[#4B6E84]">
              <Sparkles className="h-3 w-3" strokeWidth={1.75} />
              raport
            </span>
          )}
          {task.googleEventId && (
            <span
              title="Zapisano w Kalendarzu Google „Dom”"
              className="inline-flex items-center gap-1 text-[#4A7C6A] font-medium"
            >
              <CalendarCheck className="h-3 w-3" strokeWidth={1.75} />
              Dom
            </span>
          )}
          {task.dueAt && (
            <span
              className={`inline-flex items-center gap-1 ${
                isOverdue ? 'text-[#A94B3E] font-medium' : 'text-[#5C584F]'
              }`}
            >
              <Calendar className="h-3 w-3" strokeWidth={1.75} />
              {formatShortDate(task.dueAt)}
            </span>
          )}
          {task.reminderAt && !task.reminderSentAt && (
            <span className="inline-flex items-center gap-1 text-[#9C6B30]">
              <Bell className="h-3 w-3" strokeWidth={1.75} />
              {formatShortDate(task.reminderAt)}
            </span>
          )}
          {task.checklist.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <CheckSquare className="h-3 w-3" strokeWidth={1.75} />
              {completedCount}/{task.checklist.length}
            </span>
          )}
          {task.messages.length > 0 && (
            <span className="inline-flex items-center gap-1 ml-auto">
              <MessageSquare className="h-3 w-3" strokeWidth={1.75} />
              {task.messages.length}
            </span>
          )}
        </div>
      )}
    </article>
  );
}
