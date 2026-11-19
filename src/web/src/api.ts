import type {
  ArtifactType,
  AuthState,
  CheckoutProfile,
  CheckoutProfileState,
  CheckoutSession,
  FishboneBoneStatus,
  FishboneOwner,
  TaskColumn,
  TaskDetail,
  TaskPriority,
} from './types';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getAuth: () => apiFetch<AuthState>('/api/auth/me'),

  login: (password: string) =>
    apiFetch<{ ok: boolean }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  listTasks: () => apiFetch<{ tasks: TaskDetail[] }>('/api/tasks'),

  getTask: (id: string) => apiFetch<{ task: TaskDetail }>(`/api/tasks/${id}`),

  createTask: (prompt: string, files: File[]) => {
    const form = new FormData();
    form.append('prompt', prompt);
    for (const file of files) {
      form.append('files', file);
    }
    return apiFetch<{ task: TaskDetail }>('/api/tasks', {
      method: 'POST',
      body: form,
    });
  },

  updateTask: (
    id: string,
    patch: Partial<{
      title: string;
      columnStatus: TaskColumn;
      priority: TaskPriority;
      category: string;
      dueAt: string | null;
      reminderAt: string | null;
    }>
  ) =>
    apiFetch<{ task: TaskDetail }>(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteTask: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),

  addMessage: (id: string, content: string) =>
    apiFetch<{ ok: boolean }>(`/api/tasks/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),

  rerunResearch: (id: string, instruction?: string) =>
    apiFetch<{ ok: boolean }>(`/api/tasks/${id}/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
    }),

  addChecklistItem: (id: string, text: string) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(`/api/tasks/${id}/checklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }),

  toggleChecklistItem: (id: string, itemId: string, completed?: boolean) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(
      `/api/tasks/${id}/checklist/${itemId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed }),
      }
    ),

  deleteChecklistItem: (id: string, itemId: string) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(
      `/api/tasks/${id}/checklist/${itemId}`,
      {
        method: 'DELETE',
      }
    ),

  addArtifact: (
    id: string,
    payload: {
      type: ArtifactType;
      title: string;
      content: string;
      url?: string | null;
      boneId?: string | null;
      meta?: Record<string, string>;
    }
  ) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(`/api/tasks/${id}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  assignArtifactToBone: (
    id: string,
    artifactId: string,
    boneId: string | null
  ) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(
      `/api/tasks/${id}/artifacts/${artifactId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boneId }),
      }
    ),

  deleteArtifact: (id: string, artifactId: string) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(
      `/api/tasks/${id}/artifacts/${artifactId}`,
      { method: 'DELETE' }
    ),

  generateFishbone: (
    id: string,
    payload?: { customHint?: string; pinAsBigThing?: boolean }
  ) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(
      `/api/tasks/${id}/fishbone/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      }
    ),

  updateFishboneMeta: (
    id: string,
    patch: Partial<{
      headGoal: string;
      tailOutcome: string;
      isPinnedBigThing: boolean;
    }>
  ) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(`/api/tasks/${id}/fishbone`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteFishbone: (id: string) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(`/api/tasks/${id}/fishbone`, {
      method: 'DELETE',
    }),

  addFishboneBone: (
    id: string,
    payload: {
      title: string;
      description?: string;
      owner?: FishboneOwner;
      aiPrompt?: string | null;
      subItems?: Array<{ text: string; isOption?: boolean }>;
    }
  ) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(
      `/api/tasks/${id}/fishbone/bones`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    ),

  updateFishboneBone: (
    id: string,
    boneId: string,
    patch: Partial<{
      selectedArtifactId: string | null;
      selectSubItemId: string;
      toggleSubItemId: string;
      addSubItemText: string;
      status: FishboneBoneStatus;
      owner: FishboneOwner;
      title: string;
      description: string;
      aiPrompt: string | null;
    }>
  ) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(
      `/api/tasks/${id}/fishbone/bones/${boneId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }
    ),

  runFishboneBoneAi: (id: string, boneId: string, instruction?: string) =>
    apiFetch<{ ok: boolean }>(
      `/api/tasks/${id}/fishbone/bones/${boneId}/run-ai`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
      }
    ),

  deleteFishboneBone: (id: string, boneId: string) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(
      `/api/tasks/${id}/fishbone/bones/${boneId}`,
      { method: 'DELETE' }
    ),

  getCheckoutProfile: (edit = false) =>
    apiFetch<CheckoutProfileState>(
      `/api/checkout/profile${edit ? '?edit=1' : ''}`
    ),

  saveCheckoutProfile: (profile: CheckoutProfile) =>
    apiFetch<{ ok: boolean; configured: boolean; masked: Record<string, string> | null }>(
      '/api/checkout/profile',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      }
    ),

  prepareCheckout: (payload: {
    taskId: string;
    artifactId?: string | null;
    productUrl?: string;
    variantHint?: string;
  }) =>
    apiFetch<{ ok: boolean; session: CheckoutSession }>('/api/checkout/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  launchCheckoutLocal: (sessionId: string) =>
    apiFetch<{ ok: boolean; session: CheckoutSession }>(
      `/api/checkout/${sessionId}/launch-local`,
      { method: 'POST' }
    ),

  completeCheckout: (sessionId: string) =>
    apiFetch<{ ok: boolean; session: CheckoutSession }>(
      `/api/checkout/${sessionId}/complete`,
      { method: 'POST' }
    ),

  cancelCheckout: (sessionId: string) =>
    apiFetch<{ ok: boolean; session: CheckoutSession }>(
      `/api/checkout/${sessionId}/cancel`,
      { method: 'POST' }
    ),

  getCalendarStatus: (verify = false) =>
    apiFetch<{
      enabled: boolean;
      calendarName: string;
      calendarIdConfigured: boolean;
      verification?: {
        ok: boolean;
        summary?: string;
        timeZone?: string;
        serviceAccountEmail?: string;
        error?: string;
      };
    }>(`/api/calendar/status${verify ? '?verify=1' : ''}`),

  addTaskToCalendar: (
    id: string,
    payload?: {
      start?: string;
      end?: string | null;
      allDay?: boolean;
      location?: string | null;
      title?: string;
    }
  ) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(`/api/tasks/${id}/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }),

  removeTaskFromCalendar: (id: string) =>
    apiFetch<{ ok: boolean; task: TaskDetail }>(`/api/tasks/${id}/calendar`, {
      method: 'DELETE',
    }),
};
