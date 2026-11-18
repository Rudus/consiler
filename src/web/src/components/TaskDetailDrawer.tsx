import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Calendar,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  MessageSquare,
  Package,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { api } from '../api';
import type {
  ArtifactType,
  TaskColumn,
  TaskDetail,
  TaskPriority,
} from '../types';
import { ArtifactCard } from './ArtifactCard';
import { CheckoutSessionCard } from './CheckoutSessionCard';
import { FishboneWorkspace } from './FishboneWorkspace';
import { PaperTab } from './PaperTabs';

function toLocalDatetimeInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeInput(val: string): string | null {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatCompactDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('pl-PL', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

type DrawerTab = 'overview' | 'fishbone' | 'research' | 'chat';

interface TaskDetailDrawerProps {
  task: TaskDetail | null;
  onClose: () => void;
  onUpdated: (task: TaskDetail) => void;
  onDeleted: (taskId: string) => void;
  onPrepareCheckout?: (taskId: string, artifactId: string, url: string) => void;
  onOpenFullFishbone?: () => void;
}

export function TaskDetailDrawer({
  task,
  onClose,
  onUpdated,
  onDeleted,
  onPrepareCheckout,
  onOpenFullFishbone,
}: TaskDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>('overview');
  const [researchView, setResearchView] = useState<'artifacts' | 'report'>(
    'artifacts'
  );
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [messageInput, setMessageInput] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);
  const [newCheckItem, setNewCheckItem] = useState('');
  const [copiedReport, setCopiedReport] = useState(false);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [showAddArtifact, setShowAddArtifact] = useState(false);
  const [artType, setArtType] = useState<ArtifactType>('link');
  const [artTitle, setArtTitle] = useState('');
  const [artUrl, setArtUrl] = useState('');
  const [artContent, setArtContent] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [task?.messages.length, activeTab]);

  useEffect(() => {
    if (!task) return;
    setActiveTab('overview');
    setResearchView((task.artifacts?.length ?? 0) > 0 ? 'artifacts' : 'report');
    setShowAddArtifact(false);
    setDetailsOpen(false);
  }, [task?.id]);

  if (!task) return null;

  const handlePatch = async (
    patch: Partial<{
      columnStatus: TaskColumn;
      priority: TaskPriority;
      dueAt: string | null;
      reminderAt: string | null;
    }>
  ) => {
    const res = await api.updateTask(task.id, patch);
    onUpdated(res.task);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = messageInput.trim();
    if (!content || sendingMsg) return;
    setSendingMsg(true);
    setMessageInput('');
    try {
      await api.addMessage(task.id, content);
    } finally {
      setSendingMsg(false);
    }
  };

  const handleAddChecklist = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = newCheckItem.trim();
    if (!text) return;
    setNewCheckItem('');
    const res = await api.addChecklistItem(task.id, text);
    if (res.task) {
      onUpdated(res.task);
    }
  };

  const handleCopyReport = async () => {
    if (!task.researchReport) return;
    await navigator.clipboard.writeText(task.researchReport);
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 1800);
  };

  const handleDelete = async () => {
    if (!confirm('Usunąć to zadanie z tablicy?')) return;
    await api.deleteTask(task.id);
    onDeleted(task.id);
    onClose();
  };

  const completedChecklist = task.checklist.filter((c) => c.completed).length;
  const artifactCount = task.artifacts?.length ?? 0;
  const boneCount = task.fishbone?.bones.length ?? 0;
  const doneBoneCount =
    task.fishbone?.bones.filter((b) => b.status === 'done').length ?? 0;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-[#1F1E1B]/30 backdrop-blur-[2px] flex justify-end"
        onClick={onClose}
      >
        <div
          className="w-full max-w-2xl h-full bg-[#FAF8F3] border-l border-[#DDD6C7] shadow-[-12px_0_40px_rgba(31,30,27,0.12)] flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Editorial Drawer Header */}
          <div className="px-6 pt-5 pb-4 border-b border-[#DDD6C7] bg-[#FDFCF9]">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="flex items-center gap-2 font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#8E897E]">
                <span>{task.category}</span>
                {task.discordThreadId && (
                  <>
                    <span>·</span>
                    <span className="text-[#4B6E84]">Discord 1:1</span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => api.rerunResearch(task.id)}
                  disabled={task.columnStatus === 'ai_processing'}
                  title="Uruchom lub odśwież research AI w tle"
                  className="inline-flex items-center gap-1.5 rounded border border-[#C6D6CF] bg-[#E8F0EC] hover:bg-[#DCE8E2] disabled:opacity-50 px-2.5 py-1 text-[11px] font-medium text-[#2F5949] transition"
                >
                  {task.columnStatus === 'ai_processing' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  <span>Research AI</span>
                </button>

                <button
                  type="button"
                  onClick={handleDelete}
                  title="Usuń zadanie"
                  className="rounded border border-transparent hover:border-[#E5C9C4] hover:bg-[#F7EAE8] hover:text-[#A94B3E] p-1.5 text-[#8E897E] transition"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.65} />
                </button>

                <button
                  type="button"
                  onClick={onClose}
                  title="Zamknij"
                  className="rounded border border-transparent hover:bg-[#EFECE3] p-1.5 text-[#5C584F] hover:text-[#1F1E1B] transition"
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            </div>

            <h2 className="font-serif-editorial text-2xl font-normal text-[#1F1E1B] leading-snug">
              {task.title}
            </h2>

            {/* Slim Inline Status & Priority Strip */}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
              <label className="inline-flex items-center gap-1.5 text-[#7A7468]">
                <span className="font-mono-spec text-[10px] tracking-[0.12em] uppercase">
                  Kolumna
                </span>
                <select
                  value={task.columnStatus}
                  onChange={(e) =>
                    void handlePatch({
                      columnStatus: e.target.value as TaskColumn,
                    })
                  }
                  className="rounded border border-[#DDD6C7] bg-[#FAF8F3] px-2 py-1 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                >
                  <option value="ai_processing">W analizie</option>
                  <option value="ready_inbox">Inbox</option>
                  <option value="scheduled">W toku</option>
                  <option value="done">Zrobione</option>
                </select>
              </label>

              <label className="inline-flex items-center gap-1.5 text-[#7A7468]">
                <span className="font-mono-spec text-[10px] tracking-[0.12em] uppercase">
                  Priorytet
                </span>
                <select
                  value={task.priority}
                  onChange={(e) =>
                    void handlePatch({
                      priority: e.target.value as TaskPriority,
                    })
                  }
                  className="rounded border border-[#DDD6C7] bg-[#FAF8F3] px-2 py-1 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                >
                  <option value="low">Niski</option>
                  <option value="medium">Średni</option>
                  <option value="high">Ważne</option>
                  <option value="urgent">Pilne</option>
                </select>
              </label>

              {(task.dueAt || task.reminderAt) && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('overview');
                    setDetailsOpen(true);
                  }}
                  className="ml-auto inline-flex items-center gap-1.5 font-mono-spec text-[10.5px] text-[#5C584F] hover:text-[#1F1E1B] bg-[#EFECE3] border border-[#DDD6C7] rounded px-2 py-0.5"
                >
                  <Calendar className="h-3 w-3 text-[#9C6B30]" />
                  <span>
                    {formatCompactDateTime(task.dueAt || task.reminderAt)}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Notebook Pastel Index Tabs */}
          <div className="px-6 pt-2 border-b border-[#DDD6C7] bg-[#F4F1EA]/65 flex items-end gap-1 overflow-x-auto">
            <PaperTab
              active={activeTab === 'overview'}
              tone="sage"
              onClick={() => setActiveTab('overview')}
            >
              <span>Notatka & Kroki</span>
              {task.checklist.length > 0 && (
                <span className="opacity-75">
                  {completedChecklist}/{task.checklist.length}
                </span>
              )}
            </PaperTab>

            <PaperTab
              active={activeTab === 'fishbone'}
              tone="ochre"
              onClick={() => setActiveTab('fishbone')}
            >
              <span>🦴 Ość</span>
              {boneCount > 0 && (
                <span className="opacity-75">
                  {doneBoneCount}/{boneCount}
                </span>
              )}
            </PaperTab>

            <PaperTab
              active={activeTab === 'research'}
              tone="blue"
              onClick={() => setActiveTab('research')}
            >
              <Package className="h-3 w-3" />
              <span>Artefakty & Raport</span>
              {(artifactCount > 0 || task.researchReport) && (
                <span className="opacity-75">
                  {artifactCount > 0 ? artifactCount : '•'}
                </span>
              )}
            </PaperTab>

            <PaperTab
              active={activeTab === 'chat'}
              tone="sand"
              onClick={() => setActiveTab('chat')}
            >
              <MessageSquare className="h-3 w-3" />
              <span>Czat</span>
              {task.messages.length > 0 && (
                <span className="opacity-75">{task.messages.length}</span>
              )}
            </PaperTab>
          </div>

          {/* TAB 1: OVERVIEW (Summary, Checklist, Attachments, Collapsible Meta) */}
          {activeTab === 'overview' && (
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {task.aiSummary && (
                <div className="border-l-2 border-[#4A7C6A] pl-3.5 py-0.5">
                  <div className="font-mono-spec text-[9.5px] tracking-[0.14em] uppercase text-[#4A7C6A] mb-1">
                    Podsumowanie
                  </div>
                  <p className="text-[13px] text-[#36332D] leading-relaxed">
                    {task.aiSummary}
                  </p>
                </div>
              )}

              {/* Checklist */}
              <section className="space-y-2.5">
                <div className="flex items-center justify-between border-b border-[#EAE4D7] pb-1.5">
                  <h3 className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#7A7468]">
                    Kroki do wykonania
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveTab('fishbone')}
                      className="inline-flex items-center gap-1 rounded border border-[#D6C9AD] bg-[#EFE6D2]/75 hover:bg-[#EFE6D2] px-2 py-0.5 font-mono-spec text-[9.5px] uppercase text-[#2B251A] transition"
                    >
                      <span>🦴</span>
                      <span>
                        {boneCount > 0
                          ? `Ość (${doneBoneCount}/${boneCount})`
                          : 'Rozbij na ość'}
                      </span>
                    </button>
                    <span className="font-mono-spec text-[10px] text-[#8E897E]">
                      {completedChecklist}/{task.checklist.length}
                    </span>
                  </div>
                </div>

                <div className="divide-y divide-[#EFECE3]">
                  {task.checklist.map((item) => (
                    <div
                      key={item.id}
                      className="group flex items-start gap-2.5 py-2"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          void api
                            .toggleChecklistItem(
                              task.id,
                              item.id,
                              !item.completed
                            )
                            .then((res) => {
                              if (res.task) onUpdated(res.task);
                            })
                        }
                        className="mt-0.5 text-[#8E897E] hover:text-[#4A7C6A] transition"
                      >
                        {item.completed ? (
                          <CheckSquare className="h-4 w-4 text-[#4A7C6A]" />
                        ) : (
                          <Square className="h-4 w-4" strokeWidth={1.6} />
                        )}
                      </button>
                      <span
                        className={`flex-1 text-[13px] leading-relaxed ${
                          item.completed
                            ? 'line-through text-[#9A9488]'
                            : 'text-[#1F1E1B]'
                        }`}
                      >
                        {item.text}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void api
                            .deleteChecklistItem(task.id, item.id)
                            .then((res) => {
                              if (res.task) onUpdated(res.task);
                            })
                        }
                        className="opacity-0 group-hover:opacity-100 text-[#9A9488] hover:text-[#A94B3E] p-0.5 transition"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                <form onSubmit={handleAddChecklist} className="flex gap-2 pt-1">
                  <input
                    type="text"
                    value={newCheckItem}
                    onChange={(e) => setNewCheckItem(e.target.value)}
                    placeholder="Dodaj kolejny krok..."
                    className="flex-1 border-b border-[#DDD6C7] focus:border-[#4A7C6A] bg-transparent px-1 py-1.5 text-xs text-[#1F1E1B] placeholder:text-[#9A9488] focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="rounded border border-[#DDD6C7] bg-[#FDFCF9] hover:bg-[#EFECE3] px-2.5 py-1 text-xs text-[#5C584F] hover:text-[#1F1E1B] transition"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </form>
              </section>

              {/* Screenshots */}
              {task.attachments.length > 0 && (
                <section className="space-y-2.5">
                  <h3 className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#7A7468] border-b border-[#EAE4D7] pb-1.5">
                    Załączniki ({task.attachments.length})
                  </h3>
                  <div className="grid grid-cols-2 gap-2.5">
                    {task.attachments.map((att) => (
                      <button
                        key={att.id}
                        type="button"
                        onClick={() =>
                          setZoomImage(`/api/uploads/${att.filename}`)
                        }
                        className="group relative overflow-hidden rounded-lg border border-[#DDD6C7] bg-[#EFECE3] text-left aspect-video"
                      >
                        <img
                          src={`/api/uploads/${att.filename}`}
                          alt={att.originalName}
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute bottom-1.5 right-1.5 font-mono-spec text-[10px] px-1.5 py-0.5 rounded bg-[#1F1E1B]/75 text-[#FAF8F3] opacity-0 group-hover:opacity-100 transition">
                          Powiększ
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Collapsible Dates & Raw AI Context */}
              <section className="rounded-lg border border-[#DDD6C7] bg-[#F4F1EA]/70 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setDetailsOpen((v) => !v)}
                  className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-[#EFECE3]/60 transition"
                >
                  <div className="flex items-center gap-2">
                    {detailsOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-[#7A7468]" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-[#7A7468]" />
                    )}
                    <span className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#5C584F]">
                      Terminy, przypomnienia i kontekst AI
                    </span>
                  </div>
                  {!detailsOpen && (task.dueAt || task.reminderAt) && (
                    <span className="font-mono-spec text-[10px] text-[#7A7468]">
                      {task.dueAt ? `Termin: ${formatCompactDateTime(task.dueAt)}` : ''}
                    </span>
                  )}
                </button>

                {detailsOpen && (
                  <div className="px-4 pb-4 pt-2 border-t border-[#DDD6C7] space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                          Termin wykonania
                        </label>
                        <input
                          type="datetime-local"
                          value={toLocalDatetimeInput(task.dueAt)}
                          onChange={(e) =>
                            void handlePatch({
                              dueAt: fromLocalDatetimeInput(e.target.value),
                            })
                          }
                          className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2.5 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                          Przypomnienie Discord
                        </label>
                        <input
                          type="datetime-local"
                          value={toLocalDatetimeInput(task.reminderAt)}
                          onChange={(e) =>
                            void handlePatch({
                              reminderAt: fromLocalDatetimeInput(
                                e.target.value
                              ),
                            })
                          }
                          className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2.5 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                        />
                      </div>
                    </div>

                    {task.userPrompt && (
                      <div>
                        <div className="font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#8E897E] mb-1">
                          Hasło wejściowe
                        </div>
                        <p className="text-xs text-[#36332D] whitespace-pre-wrap bg-[#FDFCF9] border border-[#EAE4D7] rounded p-2.5">
                          {task.userPrompt}
                        </p>
                      </div>
                    )}

                    {task.aiReasoning && (
                      <div>
                        <div className="font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#4A7C6A] mb-1">
                          Rozumowanie AI (Triage)
                        </div>
                        <p className="text-xs text-[#5C584F] leading-relaxed">
                          {task.aiReasoning}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* TAB 1.5: FISHBONE (Graf Rybiej Ości) */}
          {activeTab === 'fishbone' && (
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <FishboneWorkspace
                task={task}
                mode="drawer"
                onUpdated={onUpdated}
                onPrepareCheckout={onPrepareCheckout}
                onOpenFullPage={() => {
                  onOpenFullFishbone?.();
                  onClose();
                }}
              />
            </div>
          )}

          {/* TAB 2: ARTIFACTS & REPORT */}
          {activeTab === 'research' && (
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[#DDD6C7]">
                <div className="flex items-end gap-1">
                  <PaperTab
                    size="sm"
                    active={researchView === 'artifacts'}
                    tone="blue"
                    onClick={() => setResearchView('artifacts')}
                  >
                    <Package className="h-3 w-3" />
                    <span>Artefakty ({artifactCount})</span>
                  </PaperTab>
                  <PaperTab
                    size="sm"
                    active={researchView === 'report'}
                    tone="ochre"
                    onClick={() => setResearchView('report')}
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>Pełny raport</span>
                  </PaperTab>
                </div>

                {researchView === 'artifacts' && (
                  <button
                    type="button"
                    onClick={() => setShowAddArtifact((v) => !v)}
                    className="mb-1.5 inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FDFCF9] hover:bg-[#EFECE3] px-2.5 py-1 text-[11px] text-[#36332D] transition"
                  >
                    <Plus className="h-3 w-3" />
                    <span>Dodaj artefakt</span>
                  </button>
                )}

                {researchView === 'report' && task.researchReport && (
                  <button
                    type="button"
                    onClick={handleCopyReport}
                    className="mb-1.5 inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FDFCF9] hover:bg-[#EFECE3] px-2.5 py-1 text-[11px] text-[#36332D] transition"
                  >
                    {copiedReport ? (
                      <>
                        <Check className="h-3 w-3 text-[#4A7C6A]" />
                        <span>Skopiowano</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Kopiuj</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              {researchView === 'artifacts' ? (
                <div className="space-y-3">
                  {showAddArtifact && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!artTitle.trim()) return;
                        const res = await api.addArtifact(task.id, {
                          type: artType,
                          title: artTitle.trim(),
                          content: artContent.trim(),
                          url:
                            artType === 'link' && artUrl.trim()
                              ? artUrl.trim()
                              : null,
                        });
                        onUpdated(res.task);
                        setArtTitle('');
                        setArtUrl('');
                        setArtContent('');
                        setShowAddArtifact(false);
                      }}
                      className="rounded-lg border border-[#DDD6C7] bg-[#FDFCF9] p-3.5 space-y-2.5"
                    >
                      <div className="grid grid-cols-3 gap-2">
                        <select
                          value={artType}
                          onChange={(e) =>
                            setArtType(e.target.value as ArtifactType)
                          }
                          className="rounded border border-[#DDD6C7] bg-[#FAF8F3] px-2 py-1.5 text-xs text-[#1F1E1B]"
                        >
                          <option value="link">Link / Oferta</option>
                          <option value="message">Wiadomość</option>
                          <option value="note">Notatka</option>
                        </select>
                        <input
                          type="text"
                          value={artTitle}
                          onChange={(e) => setArtTitle(e.target.value)}
                          placeholder="Tytuł artefaktu..."
                          required
                          className="col-span-2 rounded border border-[#DDD6C7] bg-[#FAF8F3] px-2.5 py-1.5 text-xs text-[#1F1E1B] placeholder:text-[#9A9488] focus:border-[#4A7C6A] focus:outline-none"
                        />
                      </div>
                      {artType === 'link' && (
                        <input
                          type="url"
                          value={artUrl}
                          onChange={(e) => setArtUrl(e.target.value)}
                          placeholder="https://..."
                          className="w-full rounded border border-[#DDD6C7] bg-[#FAF8F3] px-2.5 py-1.5 text-xs text-[#1F1E1B] placeholder:text-[#9A9488] focus:border-[#4A7C6A] focus:outline-none"
                        />
                      )}
                      <textarea
                        value={artContent}
                        onChange={(e) => setArtContent(e.target.value)}
                        rows={2}
                        placeholder={
                          artType === 'message'
                            ? 'Treść gotowej wiadomości...'
                            : 'Opis, cena lub dane referencyjne...'
                        }
                        className="w-full rounded border border-[#DDD6C7] bg-[#FAF8F3] p-2 text-xs text-[#1F1E1B] placeholder:text-[#9A9488] focus:border-[#4A7C6A] focus:outline-none resize-none"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setShowAddArtifact(false)}
                          className="rounded px-2.5 py-1 text-xs text-[#7A7468] hover:text-[#1F1E1B]"
                        >
                          Anuluj
                        </button>
                        <button
                          type="submit"
                          className="rounded bg-[#1F1E1B] hover:bg-[#33312C] px-3 py-1 text-xs font-medium text-[#FAF8F3]"
                        >
                          Zapisz
                        </button>
                      </div>
                    </form>
                  )}

                  {(task.checkoutSessions?.length ?? 0) > 0 && (
                    <div className="space-y-2.5 pb-2 border-b border-[#DDD6C7]">
                      <div className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#4A7C6A]">
                        Przygotowane sesje zakupu
                      </div>
                      {task.checkoutSessions.map((cs) => (
                        <CheckoutSessionCard
                          key={cs.id}
                          session={cs}
                          onZoomImage={setZoomImage}
                        />
                      ))}
                    </div>
                  )}

                  {artifactCount === 0 ? (
                    <p className="text-xs text-[#7A7468] py-4 leading-relaxed">
                      Brak wyodrębnionych artefaktów. Gdy asystent znajdzie oferty albo przygotuje wiadomość, pojawią się tutaj.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {task.artifacts.map((art) => {
                        const bId = art.boneId || art.meta?.boneId;
                        const matchedBone = bId
                          ? task.fishbone?.bones.find((b) => b.id === bId)
                          : null;
                        return (
                          <ArtifactCard
                            key={art.id}
                            artifact={art}
                            boneLabel={
                              matchedBone
                                ? `Ość #${matchedBone.position + 1}: ${matchedBone.title}`
                                : null
                            }
                            onPrepareCheckout={
                              art.type === 'link' && art.url && onPrepareCheckout
                                ? () =>
                                    onPrepareCheckout(task.id, art.id, art.url!)
                                : undefined
                            }
                            onDelete={() =>
                              void api
                                .deleteArtifact(task.id, art.id)
                                .then((res) => onUpdated(res.task))
                            }
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-[#DDD6C7] bg-[#FDFCF9] p-5">
                  {task.columnStatus === 'ai_processing' &&
                    !task.researchReport && (
                      <div className="flex items-center gap-2.5 text-xs text-[#3D6B5B]">
                        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                        <span>
                          Asystent przeszukuje sieć i przygotowuje raport…
                        </span>
                      </div>
                    )}

                  {task.researchReport ? (
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {task.researchReport}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    task.columnStatus !== 'ai_processing' && (
                      <p className="text-xs text-[#7A7468]">
                        Brak raportu z pracy w tle. Kliknij{' '}
                        <strong className="text-[#1F1E1B]">Research AI</strong>{' '}
                        u góry albo napisz w zakładce Czat.
                      </p>
                    )
                  )}

                  {task.researchSources.length > 0 && (
                    <div className="mt-5 pt-4 border-t border-[#EAE4D7]">
                      <div className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#8E897E] mb-2">
                        Źródła
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {task.researchSources.map((src) => (
                          <a
                            key={src.url}
                            href={src.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FAF8F3] hover:border-[#4A7C6A] px-2 py-1 text-[11px] text-[#36332D] hover:text-[#3D6B5B] transition max-w-[260px] truncate"
                          >
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            <span className="truncate">{src.title}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: SYNCHRONIZED THREAD CHAT */}
          {activeTab === 'chat' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-6 py-2 border-b border-[#EAE4D7] bg-[#F4F1EA]/60 font-mono-spec text-[10px] tracking-[0.12em] uppercase text-[#8E897E]">
                Wątek zadania · zsynchronizowany 1:1 z Discordem
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3.5">
                {task.messages.length === 0 ? (
                  <p className="font-serif-editorial italic text-sm text-[#8E897E] text-center py-12">
                    Napisz wiadomość, aby doprecyzować zadanie lub zlecić dodatkowy research.
                  </p>
                ) : (
                  task.messages.map((msg) => {
                    const isUser = msg.author === 'user';
                    return (
                      <div
                        key={msg.id}
                        className={`flex gap-2.5 ${
                          isUser ? 'justify-end' : 'justify-start'
                        }`}
                      >
                        {!isUser && (
                          <div className="h-7 w-7 rounded border border-[#C6D6CF] bg-[#E8F0EC] flex items-center justify-center text-[#3D6B5B] shrink-0 mt-0.5">
                            <Bot className="h-3.5 w-3.5" />
                          </div>
                        )}

                        <div
                          className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-xs leading-relaxed ${
                            isUser
                              ? 'bg-[#EAE5D9] border border-[#D8D1C2] text-[#1F1E1B]'
                              : 'bg-[#FDFCF9] border border-[#DDD6C7] text-[#2B2924]'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1 font-mono-spec text-[9.5px] uppercase tracking-[0.1em] text-[#8E897E]">
                            <span>{isUser ? 'Ty' : 'Consiler'}</span>
                            <span>·</span>
                            <span>{msg.source}</span>
                          </div>
                          <div className="prose prose-xs max-w-none prose-p:my-1">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {msg.content}
                            </ReactMarkdown>
                          </div>
                        </div>

                        {isUser && (
                          <div className="h-7 w-7 rounded border border-[#DDD6C7] bg-[#EFECE3] flex items-center justify-center text-[#5C584F] shrink-0 mt-0.5">
                            <User className="h-3.5 w-3.5" />
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
                <div ref={chatEndRef} />
              </div>

              <form
                onSubmit={handleSendMessage}
                className="px-6 py-3.5 border-t border-[#DDD6C7] bg-[#FDFCF9] flex gap-2"
              >
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  placeholder="Napisz np. 'poszukaj używanych' lub 'przypomnij jutro o 17'..."
                  className="flex-1 rounded border border-[#DDD6C7] bg-[#FAF8F3] px-3 py-2 text-xs text-[#1F1E1B] placeholder:text-[#9A9488] focus:border-[#4A7C6A] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!messageInput.trim() || sendingMsg}
                  className="inline-flex items-center gap-1.5 rounded bg-[#1F1E1B] hover:bg-[#33312C] disabled:opacity-45 px-3.5 py-2 text-xs font-medium text-[#FAF8F3] transition"
                >
                  {sendingMsg ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  <span>Wyślij</span>
                </button>
              </form>
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {zoomImage && (
        <div
          className="fixed inset-0 z-50 bg-[#1F1E1B]/85 backdrop-blur-xs flex items-center justify-center p-6"
          onClick={() => setZoomImage(null)}
        >
          <img
            src={zoomImage}
            alt="Podgląd zrzutu"
            className="max-w-full max-h-full object-contain rounded border border-[#DDD6C7] shadow-2xl"
          />
        </div>
      )}
    </>
  );
}
