import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { ArtifactsView } from './components/ArtifactsView';
import { Header, type DashboardViewMode } from './components/Header';
import { KanbanBoard } from './components/KanbanBoard';
import { LoginView } from './components/LoginView';
import { NotebookSpine } from './components/NotebookSpine';
import { OneBigThingView } from './components/OneBigThingView';
import { QuickAddModal } from './components/QuickAddModal';
import { ShippingProfileModal } from './components/ShippingProfileModal';
import { TaskDetailDrawer } from './components/TaskDetailDrawer';
import type { AuthState, TaskColumn, TaskDetail, TaskMessage } from './types';

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('task');
  });
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<DashboardViewMode>('board');
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [shippingModalOpen, setShippingModalOpen] = useState(false);
  const [shippingConfigured, setShippingConfigured] = useState(false);
  const [pastedFiles, setPastedFiles] = useState<File[]>([]);
  const [sseConnected, setSseConnected] = useState(false);

  const loadAuthAndTasks = useCallback(async () => {
    const authState = await api.getAuth();
    setAuth(authState);
    if (authState.authenticated) {
      const [data, profileState] = await Promise.all([
        api.listTasks(),
        api.getCheckoutProfile(false).catch(() => null),
      ]);
      setTasks(data.tasks);
      if (profileState) {
        setShippingConfigured(profileState.configured);
      }
    }
  }, []);

  useEffect(() => {
    void loadAuthAndTasks();
  }, [loadAuthAndTasks]);

  // Live SSE updates
  useEffect(() => {
    if (!auth?.authenticated) return;
    const es = new EventSource('/api/events', { withCredentials: true });

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.addEventListener('ping', () => setSseConnected(true));

    es.addEventListener('task:created', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as {
          payload: TaskDetail;
        };
        if (!parsed.payload) return;
        setTasks((prev) => {
          const exists = prev.some((t) => t.id === parsed.payload.id);
          if (exists) {
            return prev.map((t) =>
              t.id === parsed.payload.id ? parsed.payload : t
            );
          }
          return [parsed.payload, ...prev];
        });
      } catch {
        // Ignore malformed SSE
      }
    });

    es.addEventListener('task:updated', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as {
          payload: TaskDetail;
        };
        if (!parsed.payload) return;
        setTasks((prev) =>
          prev.map((t) => (t.id === parsed.payload.id ? parsed.payload : t))
        );
      } catch {
        // Ignore
      }
    });

    es.addEventListener('task:deleted', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as {
          taskId: string;
        };
        setTasks((prev) => prev.filter((t) => t.id !== parsed.taskId));
        setSelectedTaskId((cur) => (cur === parsed.taskId ? null : cur));
      } catch {
        // Ignore
      }
    });

    es.addEventListener('message:created', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as {
          taskId: string;
          payload: TaskMessage;
        };
        if (!parsed.payload) return;
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== parsed.taskId) return t;
            if (t.messages.some((m) => m.id === parsed.payload.id)) return t;
            return { ...t, messages: [...t.messages, parsed.payload] };
          })
        );
      } catch {
        // Ignore
      }
    });

    return () => {
      es.close();
      setSseConnected(false);
    };
  }, [auth?.authenticated]);

  // Global Ctrl+V screenshot paste handler
  useEffect(() => {
    if (!auth?.authenticated) return;
    const onPaste = (e: ClipboardEvent) => {
      if (quickAddOpen) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith('image/')
      );
      if (files.length > 0) {
        e.preventDefault();
        setPastedFiles(files);
        setQuickAddOpen(true);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [auth?.authenticated, quickAddOpen]);

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.aiSummary.toLowerCase().includes(q) ||
        t.userPrompt.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
    );
  }, [tasks, search]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );

  const handleMoveTask = async (taskId: string, column: TaskColumn) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, columnStatus: column } : t))
    );
    try {
      const res = await api.updateTask(taskId, { columnStatus: column });
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? res.task : t))
      );
    } catch {
      void loadAuthAndTasks();
    }
  };

  const handleToggleDone = async (task: TaskDetail) => {
    const nextCol: TaskColumn =
      task.columnStatus === 'done' ? 'ready_inbox' : 'done';
    await handleMoveTask(task.id, nextCol);
  };

  const handlePrepareCheckout = async (
    taskId: string,
    artifactId: string,
    productUrl: string
  ) => {
    if (!shippingConfigured) {
      setShippingModalOpen(true);
      return;
    }
    try {
      await api.prepareCheckout({ taskId, artifactId, productUrl });
      setSelectedTaskId(taskId);
    } catch (err) {
      alert(
        err instanceof Error
          ? err.message
          : 'Nie udało się uruchomić sesji zakupu.'
      );
    }
  };

  const activeTaskCount = useMemo(
    () => tasks.filter((t) => t.columnStatus !== 'done').length,
    [tasks]
  );

  const activeArtifactCount = useMemo(
    () =>
      tasks
        .filter((t) => t.columnStatus !== 'done')
        .reduce((acc, t) => acc + (t.artifacts?.length ?? 0), 0),
    [tasks]
  );

  const activeFishboneCount = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.columnStatus !== 'done' && (t.fishbone?.bones.length ?? 0) > 0
      ).length,
    [tasks]
  );

  if (!auth) {
    return (
      <div className="min-h-screen bg-dot-grid flex items-center justify-center font-serif-editorial italic text-sm text-[#7A7468]">
        Otwieranie dziennika Consiler…
      </div>
    );
  }

  if (auth.authRequired && !auth.authenticated) {
    return <LoginView onSuccess={() => void loadAuthAndTasks()} />;
  }

  return (
    <div className="min-h-screen bg-dot-grid text-[#1F1E1B] flex">
      <NotebookSpine
        auth={auth}
        sseConnected={sseConnected}
        viewMode={viewMode}
        artifactCount={activeArtifactCount}
        fishboneCount={activeFishboneCount}
        onViewModeChange={setViewMode}
        onOpenQuickAdd={() => {
          setPastedFiles([]);
          setQuickAddOpen(true);
        }}
        onLogout={() => void api.logout().then(() => loadAuthAndTasks())}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <Header
          auth={auth}
          sseConnected={sseConnected}
          viewMode={viewMode}
          activeCount={activeTaskCount}
          artifactCount={activeArtifactCount}
          fishboneCount={activeFishboneCount}
          shippingConfigured={shippingConfigured}
          search={search}
          onViewModeChange={setViewMode}
          onSearchChange={setSearch}
          onOpenShippingProfile={() => setShippingModalOpen(true)}
          onOpenQuickAdd={() => {
            setPastedFiles([]);
            setQuickAddOpen(true);
          }}
          onLogout={() => void api.logout().then(() => loadAuthAndTasks())}
        />

        <main className="flex-1 max-w-[1520px] w-full mx-auto px-4 sm:px-8 py-6">
          {viewMode === 'board' ? (
            <KanbanBoard
              tasks={filteredTasks}
              selectedTaskId={selectedTaskId}
              onSelectTask={(id) => setSelectedTaskId(id)}
              onMoveTask={handleMoveTask}
              onToggleDone={handleToggleDone}
            />
          ) : viewMode === 'fishbone' ? (
            <OneBigThingView
              tasks={filteredTasks}
              onUpdated={(updated) =>
                setTasks((prev) =>
                  prev.map((t) => (t.id === updated.id ? updated : t))
                )
              }
              onSelectTaskDrawer={(id) => setSelectedTaskId(id)}
              onOpenQuickAdd={() => {
                setPastedFiles([]);
                setQuickAddOpen(true);
              }}
              onPrepareCheckout={handlePrepareCheckout}
            />
          ) : (
            <ArtifactsView
              tasks={tasks}
              search={search}
              onSelectTask={(id) => setSelectedTaskId(id)}
              onPrepareCheckout={handlePrepareCheckout}
              onDeleteArtifact={(taskId, artifactId) =>
                void api.deleteArtifact(taskId, artifactId).then((res) =>
                  setTasks((prev) =>
                    prev.map((t) => (t.id === res.task.id ? res.task : t))
                  )
                )
              }
            />
          )}
        </main>
      </div>

      <ShippingProfileModal
        open={shippingModalOpen}
        onClose={() => setShippingModalOpen(false)}
        onSaved={(configured) => setShippingConfigured(configured)}
      />

      <QuickAddModal
        open={quickAddOpen}
        initialFiles={pastedFiles}
        onClose={() => {
          setQuickAddOpen(false);
          setPastedFiles([]);
        }}
        onCreated={(id) => setSelectedTaskId(id)}
      />

      <TaskDetailDrawer
        task={selectedTask}
        calendarEnabled={auth.calendarEnabled}
        calendarName={auth.calendarName}
        onClose={() => setSelectedTaskId(null)}
        onPrepareCheckout={handlePrepareCheckout}
        onOpenFullFishbone={() => setViewMode('fishbone')}
        onUpdated={(updated) =>
          setTasks((prev) =>
            prev.map((t) => (t.id === updated.id ? updated : t))
          )
        }
        onDeleted={(id) =>
          setTasks((prev) => prev.filter((t) => t.id !== id))
        }
      />
    </div>
  );
}
