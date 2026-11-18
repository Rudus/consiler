import { useState } from 'react';
import { ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { TaskColumn, TaskDetail } from '../types';
import { TaskCard } from './TaskCard';

interface ColumnMeta {
  id: TaskColumn;
  index: string;
  title: string;
  subtitle: string;
  dotColor: string;
}

const COLUMNS: ColumnMeta[] = [
  {
    id: 'ai_processing',
    index: '01',
    title: 'W analizie',
    subtitle: 'Praca w tle',
    dotColor: 'bg-[#4A7C6A]',
  },
  {
    id: 'ready_inbox',
    index: '02',
    title: 'Inbox',
    subtitle: 'Gotowe do decyzji',
    dotColor: 'bg-[#4B6E84]',
  },
  {
    id: 'scheduled',
    index: '03',
    title: 'W toku',
    subtitle: 'Zaplanowane i bieżące',
    dotColor: 'bg-[#9C6B30]',
  },
  {
    id: 'done',
    index: '04',
    title: 'Zrobione',
    subtitle: 'Zamknięte',
    dotColor: 'bg-[#8E897E]',
  },
];

interface KanbanBoardProps {
  tasks: TaskDetail[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onMoveTask: (taskId: string, column: TaskColumn) => void;
  onToggleDone: (task: TaskDetail) => void;
}

export function KanbanBoard({
  tasks,
  selectedTaskId,
  onSelectTask,
  onMoveTask,
  onToggleDone,
}: KanbanBoardProps) {
  const [dragOverCol, setDragOverCol] = useState<TaskColumn | null>(null);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);

  return (
    <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-start">
      {COLUMNS.map((col) => {
        const colTasks = tasks.filter((t) => t.columnStatus === col.id);
        const isOver = dragOverCol === col.id;

        const isCollapsible = col.id === 'ai_processing' || col.id === 'done';
        const isCollapsed =
          (col.id === 'ai_processing' && colTasks.length === 0 && !aiExpanded) ||
          (col.id === 'done' && !doneExpanded);

        const toggleCollapse = () => {
          if (col.id === 'ai_processing') setAiExpanded((v) => !v);
          if (col.id === 'done') setDoneExpanded((v) => !v);
        };

        if (isCollapsed) {
          return (
            <section
              key={col.id}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverCol(col.id);
              }}
              onDragLeave={() => setDragOverCol(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverCol(null);
                const taskId = e.dataTransfer.getData('text/plain');
                if (taskId) {
                  onMoveTask(taskId, col.id);
                }
              }}
              onClick={toggleCollapse}
              title={`Rozwiń kolumnę „${col.title}” (${colTasks.length})`}
              className={`cursor-pointer rounded-lg border transition-all select-none ${
                isOver
                  ? 'border-[#4A7C6A] bg-[#E8F0EC]/75'
                  : col.id === 'ai_processing'
                    ? 'border-[#D1DBC8] bg-[#E3EBDC]/45 hover:bg-[#E3EBDC]/75 hover:border-[#C2CFB6]'
                    : 'border-[#DDD6C7] bg-[#EAE4D6]/55 hover:bg-[#EAE4D6]/85 hover:border-[#CCC3AF]'
              } lg:w-12 lg:min-h-[420px] lg:py-4 lg:px-2 px-4 py-2.5 flex lg:flex-col items-center justify-between gap-3 shrink-0`}
            >
              {/* Mobile horizontal collapsed bar */}
              <div className="flex lg:hidden items-center justify-between w-full">
                <div className="flex items-center gap-2.5">
                  <span className="font-mono-spec text-[10px] text-[#8E897E]">
                    {col.index}
                  </span>
                  <span className={`h-1.5 w-1.5 rounded-full ${col.dotColor}`} />
                  <span className="font-serif-editorial text-base text-[#1F1E1B]">
                    {col.title}
                  </span>
                  <span className="font-mono-spec text-[11px] text-[#7A7468]">
                    ({colTasks.length})
                  </span>
                </div>
                <ChevronRight className="h-4 w-4 text-[#7A7468]" />
              </div>

              {/* Desktop vertical sketchbook spine */}
              <div className="hidden lg:flex flex-col items-center justify-between h-full w-full gap-4">
                <div className="flex flex-col items-center gap-2">
                  <span className="font-mono-spec text-[10px] text-[#8E897E]">
                    {col.index}
                  </span>
                  <span className={`h-1.5 w-1.5 rounded-full ${col.dotColor}`} />
                </div>

                <div
                  className="font-mono-spec text-[10.5px] tracking-[0.2em] uppercase text-[#5C584F] rotate-180 whitespace-nowrap"
                  style={{ writingMode: 'vertical-rl' }}
                >
                  {col.title}
                </div>

                <div className="flex flex-col items-center gap-2">
                  <span className="font-mono-spec text-[11px] font-medium text-[#5C584F] bg-[#EFECE3] border border-[#DDD6C7] rounded px-1.5 py-0.5">
                    {colTasks.length}
                  </span>
                  {col.id === 'done' ? (
                    <PanelRightOpen className="h-3.5 w-3.5 text-[#8E897E]" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-[#8E897E]" />
                  )}
                </div>
              </div>
            </section>
          );
        }

        return (
          <section
            key={col.id}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverCol(col.id);
            }}
            onDragLeave={() => setDragOverCol(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverCol(null);
              const taskId = e.dataTransfer.getData('text/plain');
              if (taskId) {
                onMoveTask(taskId, col.id);
              }
            }}
            className={`flex-1 min-w-0 rounded-lg border transition-colors min-h-[260px] flex flex-col ${
              isOver
                ? 'border-[#4A7C6A] bg-[#E8F0EC]/45'
                : 'border-[#DDD6C7]/90 bg-[#FAF8F3]/60'
            }`}
          >
            {/* Editorial Column Header */}
            <div className="px-4 py-3 border-b border-[#DDD6C7]/80 flex items-center justify-between gap-2">
              <div className="flex items-baseline gap-2.5 min-w-0">
                <span className="font-mono-spec text-[10.5px] tracking-[0.12em] text-[#8E897E]">
                  {col.index}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${col.dotColor}`} />
                    <h2 className="font-serif-editorial text-[17px] font-normal text-[#1F1E1B] leading-none">
                      {col.title}
                    </h2>
                  </div>
                  <p className="text-[11px] text-[#8E897E] mt-1 truncate">
                    {col.subtitle}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <span className="font-mono-spec text-[11px] text-[#5C584F] bg-[#EFECE3] border border-[#DDD6C7] px-2 py-0.5 rounded">
                  {String(colTasks.length).padStart(2, '0')}
                </span>
                {isCollapsible && (col.id === 'done' || colTasks.length === 0) && (
                  <button
                    type="button"
                    onClick={toggleCollapse}
                    title={`Zwiń kolumnę „${col.title}”`}
                    className="rounded p-1 text-[#8E897E] hover:text-[#1F1E1B] hover:bg-[#EFECE3] transition"
                  >
                    {col.id === 'done' ? (
                      <PanelRightClose className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronLeft className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Cards */}
            <div className="p-3 space-y-2.5 flex-1">
              {colTasks.length === 0 ? (
                <div className="rounded border border-dashed border-[#D8D1C2] py-10 text-center">
                  <p className="font-serif-editorial italic text-sm text-[#9A9488]">
                    Pusta strona
                  </p>
                </div>
              ) : (
                colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    selected={selectedTaskId === task.id}
                    onSelect={() => onSelectTask(task.id)}
                    onQuickDone={(e) => {
                      e.stopPropagation();
                      onToggleDone(task);
                    }}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
