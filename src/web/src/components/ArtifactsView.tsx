import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Link2,
  Mail,
  Package,
  ShoppingCart,
  X,
} from 'lucide-react';
import type {
  ArtifactType,
  CheckoutSession,
  TaskColumn,
  TaskDetail,
} from '../types';
import { ArtifactCard } from './ArtifactCard';
import {
  CHECKOUT_STATUS_LABEL,
  CheckoutSessionCard,
  isActiveCheckoutSession,
} from './CheckoutSessionCard';
import { PaperTab, type PaperTabTone } from './PaperTabs';

const COLUMN_BADGE: Record<TaskColumn, string> = {
  ai_processing: 'W ANALIZIE',
  ready_inbox: 'INBOX',
  scheduled: 'W TOKU',
  done: 'ZROBIONE',
};

const EAR_TONES: Array<{
  tone: PaperTabTone;
  earCls: string;
  openBorderCls: string;
  chipCls: string;
}> = [
  {
    tone: 'blue',
    earCls: 'bg-[#DFE8EC] border-[#C2CFD6] text-[#1D2529]',
    openBorderCls: 'border-[#C2CFD6]',
    chipCls: 'bg-[#DFE8EC] border-[#C2CFD6] text-[#1D2529]',
  },
  {
    tone: 'sage',
    earCls: 'bg-[#E3EBDC] border-[#C6D1BC] text-[#1F261D]',
    openBorderCls: 'border-[#C6D1BC]',
    chipCls: 'bg-[#E3EBDC] border-[#C6D1BC] text-[#1F261D]',
  },
  {
    tone: 'ochre',
    earCls: 'bg-[#EFE6D2] border-[#D6C9AD] text-[#2B251A]',
    openBorderCls: 'border-[#D6C9AD]',
    chipCls: 'bg-[#EFE6D2] border-[#D6C9AD] text-[#2B251A]',
  },
  {
    tone: 'parchment',
    earCls: 'bg-[#EAE4D6] border-[#CEC6B4] text-[#1F1E1B]',
    openBorderCls: 'border-[#CEC6B4]',
    chipCls: 'bg-[#EAE4D6] border-[#CEC6B4] text-[#1F1E1B]',
  },
];

function pluralPl(count: number, one: string, few: string, many: string): string {
  if (count === 1) return `${count} ${one}`;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} ${few}`;
  }
  return `${count} ${many}`;
}

function formatShortDateUpper(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('pl-PL', {
    day: 'numeric',
    month: 'short',
  })
    .format(d)
    .toUpperCase();
}

function normalizeUrlForMatch(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url.trim());
    u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return u.toString();
  } catch {
    return url.trim();
  }
}

function summarizeDossier(
  artifacts: TaskDetail['artifacts'],
  sessions: CheckoutSession[]
): string {
  let links = 0;
  let messages = 0;
  let notes = 0;
  for (const a of artifacts) {
    if (a.type === 'link') links++;
    else if (a.type === 'message') messages++;
    else notes++;
  }
  const parts: string[] = [];
  if (links > 0) parts.push(pluralPl(links, 'LINK', 'LINKI', 'LINKÓW'));
  if (messages > 0)
    parts.push(pluralPl(messages, 'WIADOMOŚĆ', 'WIADOMOŚCI', 'WIADOMOŚCI'));
  if (notes > 0) parts.push(pluralPl(notes, 'NOTATKA', 'NOTATKI', 'NOTATEK'));
  if (sessions.length > 0) {
    parts.push(pluralPl(sessions.length, 'KOSZYK', 'KOSZYKI', 'KOSZYKÓW'));
  }
  return parts.join(' · ');
}

type ArtifactFilterMode = 'all' | ArtifactType | 'checkout';

interface ArtifactsViewProps {
  tasks: TaskDetail[];
  search: string;
  onSelectTask: (taskId: string) => void;
  onPrepareCheckout: (taskId: string, artifactId: string, url: string) => void;
  onDeleteArtifact: (taskId: string, artifactId: string) => void;
}

export function ArtifactsView({
  tasks,
  search,
  onSelectTask,
  onPrepareCheckout,
  onDeleteArtifact,
}: ArtifactsViewProps) {
  const [filterType, setFilterType] = useState<ArtifactFilterMode>('all');
  const [hideDone, setHideDone] = useState(true);
  // null = auto mode (first dossier open by default, or all matching when searching)
  const [expandedIds, setExpandedIds] = useState<Set<string> | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  const activeCheckoutCount = useMemo(
    () =>
      tasks
        .filter((t) => !hideDone || t.columnStatus !== 'done')
        .reduce(
          (sum, t) =>
            sum + (t.checkoutSessions ?? []).filter(isActiveCheckoutSession).length,
          0
        ),
    [tasks, hideDone]
  );

  const dossiers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups: Array<{
      task: TaskDetail;
      artifacts: TaskDetail['artifacts'];
      sessions: CheckoutSession[];
      latestAt: number;
    }> = [];

    for (const task of tasks) {
      if (hideDone && task.columnStatus === 'done') continue;
      const allArtifacts = task.artifacts ?? [];
      const allSessions = task.checkoutSessions ?? [];
      if (allArtifacts.length === 0 && allSessions.length === 0) continue;

      const taskMatchesQuery =
        q.length > 0 &&
        (task.title.toLowerCase().includes(q) ||
          task.category.toLowerCase().includes(q));

      const matchedSessions =
        filterType === 'message' || filterType === 'note'
          ? []
          : allSessions.filter((cs) => {
              if (!q || taskMatchesQuery) return true;
              const hay =
                `${cs.shopDomain} ${cs.variantNote ?? ''} ${cs.productUrl} ${cs.message}`.toLowerCase();
              return hay.includes(q);
            });

      const matchedArtifacts =
        filterType === 'checkout'
          ? []
          : allArtifacts
              .filter((artifact) => {
                if (filterType !== 'all' && artifact.type !== filterType) {
                  return false;
                }
                if (!q || taskMatchesQuery) return true;
                const hay =
                  `${artifact.title} ${artifact.content} ${artifact.url ?? ''}`.toLowerCase();
                return hay.includes(q);
              })
              .sort(
                (a, b) =>
                  new Date(b.createdAt).getTime() -
                  new Date(a.createdAt).getTime()
              );

      if (matchedArtifacts.length === 0 && matchedSessions.length === 0) {
        continue;
      }

      const latestArtifactAt = matchedArtifacts.reduce(
        (max, a) => Math.max(max, new Date(a.createdAt).getTime() || 0),
        0
      );
      const latestSessionAt = matchedSessions.reduce(
        (max, s) => Math.max(max, new Date(s.updatedAt || s.createdAt).getTime() || 0),
        0
      );

      groups.push({
        task,
        artifacts: matchedArtifacts,
        sessions: matchedSessions,
        latestAt: Math.max(latestArtifactAt, latestSessionAt),
      });
    }

    return groups.sort((a, b) => b.latestAt - a.latestAt);
  }, [tasks, search, filterType, hideDone]);

  const isDossierExpanded = (taskId: string, idx: number): boolean => {
    if (expandedIds !== null) return expandedIds.has(taskId);
    if (search.trim().length > 0) return true;
    return idx === 0;
  };

  const toggleDossier = (taskId: string, currentExpanded: boolean) => {
    setExpandedIds((prev) => {
      const next =
        prev !== null
          ? new Set(prev)
          : new Set(
              dossiers
                .filter((d, i) => isDossierExpanded(d.task.id, i))
                .map((d) => d.task.id)
            );
      if (currentExpanded) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const allExpanded =
    dossiers.length > 0 &&
    dossiers.every((d, idx) => isDossierExpanded(d.task.id, idx));

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(dossiers.map((d) => d.task.id)));
    }
  };

  return (
    <div className="space-y-6">
      {/* Editorial Pastel Paper Index Tabs + Controls */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#DDD6C7]">
        <div className="flex flex-wrap items-end gap-1">
          {[
            {
              id: 'all' as const,
              label: 'Wszystkie',
              tone: 'parchment' as const,
              icon: <Package className="h-3 w-3" />,
            },
            {
              id: 'checkout' as const,
              label:
                activeCheckoutCount > 0
                  ? `Do zakupu (${activeCheckoutCount})`
                  : 'Do zakupu',
              tone: 'sage' as const,
              icon: <ShoppingCart className="h-3 w-3" />,
            },
            {
              id: 'link' as const,
              label: 'Linki i oferty',
              tone: 'blue' as const,
              icon: <Link2 className="h-3 w-3" />,
            },
            {
              id: 'message' as const,
              label: 'Wiadomości',
              tone: 'sage' as const,
              icon: <Mail className="h-3 w-3" />,
            },
            {
              id: 'note' as const,
              label: 'Notatki',
              tone: 'ochre' as const,
              icon: <FileText className="h-3 w-3" />,
            },
          ].map((tab) => (
            <PaperTab
              key={tab.id}
              active={filterType === tab.id}
              tone={tab.tone}
              onClick={() => setFilterType(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </PaperTab>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-4 pb-2">
          {dossiers.length > 1 && (
            <button
              type="button"
              onClick={toggleAll}
              className="font-mono-spec text-[10px] tracking-[0.12em] uppercase text-[#7A7468] hover:text-[#1F1E1B] transition"
            >
              {allExpanded ? 'Zwiń wszystkie' : 'Rozwiń wszystkie'}
            </button>
          )}

          <label className="inline-flex items-center gap-2 font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#6B665C] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(e) => setHideDone(e.target.checked)}
              className="rounded border-[#CFC8B8] bg-[#FAF8F3] accent-[#4A7C6A]"
            />
            <span>Ukryj z „Zrobione”</span>
          </label>
        </div>
      </div>

      {dossiers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#D4CCB9] bg-[#FAF8F3]/60 py-16 px-6 text-center space-y-3">
          {/* Paper Concept geometric soft wash */}
          <svg
            viewBox="0 0 120 48"
            className="w-24 h-10 mx-auto text-[#4B6E84]/35"
            aria-hidden="true"
          >
            <ellipse
              cx="45"
              cy="24"
              rx="22"
              ry="16"
              transform="rotate(-15 45 24)"
              fill="currentColor"
            />
            <ellipse
              cx="74"
              cy="26"
              rx="18"
              ry="13"
              transform="rotate(20 74 26)"
              fill="#4A7C6A"
              fillOpacity="0.22"
            />
          </svg>
          <p className="font-serif-editorial text-lg text-[#1F1E1B]">
            Brak teczek z artefaktami
          </p>
          <p className="text-xs text-[#7A7468] max-w-md mx-auto leading-relaxed">
            Gdy asystent wyszuka oferty albo przygotuje szkic wiadomości dla zadania, powstanie tutaj osobna teczka z jego materiałami.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {dossiers.map(({ task, artifacts, sessions, latestAt }, idx) => {
            const expanded = isDossierExpanded(task.id, idx);
            const style = EAR_TONES[idx % EAR_TONES.length];
            const indexCode = String(idx + 1).padStart(2, '0');
            const statusLabel = COLUMN_BADGE[task.columnStatus] ?? 'INBOX';
            const breakdown = summarizeDossier(artifacts, sessions);
            const dateStr = task.dueAt
              ? `TERMIN ${formatShortDateUpper(task.dueAt)}`
              : formatShortDateUpper(new Date(latestAt).toISOString());
            const activeSession =
              sessions.find(isActiveCheckoutSession) ?? sessions[0] ?? null;
            const totalItemsCount = artifacts.length + sessions.length;

            const findLinkedSession = (artId: string, artUrl: string | null) => {
              const normArtUrl = normalizeUrlForMatch(artUrl);
              return (
                sessions.find((s) => s.artifactId === artId) ??
                (normArtUrl
                  ? sessions.find(
                      (s) => normalizeUrlForMatch(s.productUrl) === normArtUrl
                    )
                  : undefined) ??
                null
              );
            };

            if (expanded) {
              return (
                <section
                  key={task.id}
                  className="lg:col-span-2 flex flex-col"
                >
                  {/* Protruding pastel folder ear */}
                  <div className="pl-4 flex items-end gap-2">
                    <button
                      type="button"
                      onClick={() => toggleDossier(task.id, true)}
                      className={`font-mono-spec text-[10px] tracking-[0.15em] uppercase px-3.5 py-1.5 rounded-t-[6px] border border-b-0 font-medium transition ${style.earCls}`}
                    >
                      {indexCode} · {task.category} · {statusLabel}
                    </button>
                    {activeSession && (
                      <span className="font-mono-spec text-[9.5px] tracking-[0.1em] uppercase px-2.5 py-1 rounded-t-[6px] border border-b-0 border-[#C6D1BC] bg-[#E3EBDC] text-[#244337] font-semibold">
                        🛒 {CHECKOUT_STATUS_LABEL[activeSession.status]}
                        {activeSession.detectedTotal
                          ? ` · ${activeSession.detectedTotal}`
                          : ''}
                      </span>
                    )}
                  </div>

                  {/* Expanded folio body */}
                  <div
                    className={`rounded-lg border ${style.openBorderCls} bg-[#FDFCF9] p-5 sm:p-6 shadow-[0_2px_10px_rgba(31,30,27,0.04)] space-y-4`}
                  >
                    <div
                      onClick={() => toggleDossier(task.id, true)}
                      className="cursor-pointer flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-[#EAE4D7]"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <h3 className="font-serif-editorial text-xl sm:text-[22px] font-normal text-[#1F1E1B] leading-snug">
                          {task.title}
                        </h3>
                        <p className="font-mono-spec text-[10.5px] tracking-[0.08em] uppercase text-[#8E897E]">
                          {breakdown}
                          {dateStr ? `  ·  ${dateStr}` : ''}
                        </p>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectTask(task.id);
                          }}
                          className="text-xs font-medium text-[#4A7C6A] hover:text-[#2E5446] transition"
                        >
                          Otwórz zadanie →
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDossier(task.id, true);
                          }}
                          className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono-spec text-[10.5px] font-medium transition ${style.chipCls}`}
                        >
                          <span>
                            {String(totalItemsCount).padStart(2, '0')} · ZWIŃ
                          </span>
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    {sessions.length > 0 && (
                      <div className="space-y-2.5 pb-2 border-b border-[#EAE4D7]">
                        <div className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#4A7C6A]">
                          Przygotowane sesje zakupu
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                          {sessions.map((cs) => (
                            <CheckoutSessionCard
                              key={cs.id}
                              session={cs}
                              onZoomImage={setZoomImage}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {artifacts.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                        {artifacts.map((art) => (
                          <ArtifactCard
                            key={art.id}
                            artifact={art}
                            checkoutSession={findLinkedSession(art.id, art.url)}
                            onPrepareCheckout={
                              art.type === 'link' && art.url
                                ? () => onPrepareCheckout(task.id, art.id, art.url!)
                                : undefined
                            }
                            onDelete={() => onDeleteArtifact(task.id, art.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              );
            }

            return (
              <section
                key={task.id}
                onClick={() => toggleDossier(task.id, false)}
                className="group cursor-pointer flex flex-col"
              >
                {/* Protruding pastel folder ear */}
                <div className="pl-4 flex items-end gap-2">
                  <span
                    className={`font-mono-spec text-[10px] tracking-[0.14em] uppercase px-3 py-1 rounded-t-[6px] border border-b-0 transition ${style.earCls}`}
                  >
                    {indexCode} · {task.category} · {statusLabel}
                  </span>
                  {activeSession && (
                    <span className="font-mono-spec text-[9.5px] tracking-[0.08em] uppercase px-2 py-0.5 rounded-t-[5px] border border-b-0 border-[#C6D1BC] bg-[#E3EBDC] text-[#244337] font-semibold">
                      🛒 {CHECKOUT_STATUS_LABEL[activeSession.status]}
                      {activeSession.detectedTotal
                        ? ` · ${activeSession.detectedTotal}`
                        : ''}
                    </span>
                  )}
                </div>

                {/* Closed folder cover */}
                <div className="rounded-lg border border-[#DDD6C7] bg-[#FAF8F3] group-hover:bg-[#FDFCF9] group-hover:border-[#BFB6A4] px-5 py-4 transition shadow-[0_1px_2px_rgba(31,30,27,0.03)] group-hover:shadow-[0_3px_10px_rgba(31,30,27,0.05)] space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-serif-editorial text-[19px] font-normal text-[#1F1E1B] leading-snug line-clamp-2">
                      {task.title}
                    </h3>
                    <span className="inline-flex items-center gap-1.5 rounded border border-[#DDD6C7] bg-[#EAE5D9] px-2 py-1 font-mono-spec text-[10.5px] font-medium text-[#1F1E1B] shrink-0">
                      <span>{String(totalItemsCount).padStart(2, '0')}</span>
                      <ChevronRight className="h-3 w-3 text-[#7A7468] group-hover:translate-x-0.5 transition-transform" />
                    </span>
                  </div>

                  <p className="font-mono-spec text-[10.5px] tracking-[0.06em] uppercase text-[#8E897E] truncate">
                    {breakdown}
                    {dateStr ? `  ·  ${dateStr}` : ''}
                  </p>
                </div>

                {/* Tactile stacked paper slip edge peeking underneath */}
                <div className="mx-2.5 h-1 rounded-b border-x border-b border-[#DDD6C7] bg-[#EAE5D9]" />
              </section>
            );
          })}
        </div>
      )}

      {zoomImage && (
        <div
          className="fixed inset-0 z-50 bg-[#1F1E1B]/80 flex items-center justify-center p-4"
          onClick={() => setZoomImage(null)}
        >
          <button
            type="button"
            onClick={() => setZoomImage(null)}
            className="fixed top-4 right-4 rounded-full bg-[#FAF8F3] p-2 text-[#1F1E1B] shadow-lg"
            title="Zamknij"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={zoomImage}
            alt="Powiększony podgląd"
            className="max-w-full max-h-[90vh] rounded-lg shadow-2xl border border-[#DDD6C7] bg-[#FAF8F3]"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
