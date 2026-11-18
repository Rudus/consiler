export type TaskColumn =
  | 'ai_processing'
  | 'ready_inbox'
  | 'scheduled'
  | 'done';

export type BackgroundTaskType =
  | 'NONE'
  | 'WEB_RESEARCH'
  | 'DRAFT_CONTENT'
  | 'ACTION_PLAN';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type MessageAuthor = 'user' | 'assistant' | 'system';

export type MessageSource = 'discord' | 'web' | 'system';

export interface ChecklistItem {
  id: string;
  taskId: string;
  text: string;
  completed: boolean;
  position: number;
  createdAt: string;
}

export interface TaskMessage {
  id: string;
  taskId: string;
  author: MessageAuthor;
  source: MessageSource;
  content: string;
  discordMessageId: string | null;
  createdAt: string;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export type ArtifactType = 'link' | 'message' | 'note';

export interface TaskArtifact {
  id: string;
  taskId: string;
  boneId?: string | null;
  type: ArtifactType;
  title: string;
  content: string;
  url: string | null;
  meta: Record<string, string>;
  createdBy: 'assistant' | 'user';
  createdAt: string;
}

export type FishboneOwner = 'ai' | 'user' | 'shared';

export type FishboneBoneStatus =
  | 'pending'
  | 'ai_working'
  | 'needs_user'
  | 'done';

export interface FishboneSubItem {
  id: string;
  text: string;
  completed: boolean;
  isOption?: boolean;
  selected?: boolean;
}

export interface FishboneBone {
  id: string;
  taskId: string;
  position: number;
  title: string;
  description: string;
  owner: FishboneOwner;
  status: FishboneBoneStatus;
  aiPrompt: string | null;
  aiResult: string | null;
  selectedArtifactId: string | null;
  subItems: FishboneSubItem[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskFishbone {
  headGoal: string;
  tailOutcome: string;
  isPinnedBigThing: boolean;
  bones: FishboneBone[];
}

export type CheckoutSessionStatus =
  | 'PREPARING'
  | 'READY_FOR_HANDOFF'
  | 'HANDOFF_MANUAL'
  | 'LAUNCHED_LOCAL'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface CheckoutSession {
  id: string;
  taskId: string;
  artifactId: string | null;
  shopDomain: string;
  productUrl: string;
  checkoutUrl: string | null;
  status: CheckoutSessionStatus;
  variantNote: string | null;
  detectedTotal: string | null;
  detectedShipping: string | null;
  screenshotFilename: string | null;
  storageStatePath: string | null;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface CheckoutProfile {
  fullName: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
  preferredLocker: string;
  notes: string;
}

export interface Task {
  id: string;
  title: string;
  userPrompt: string;
  aiSummary: string;
  aiReasoning: string;
  columnStatus: TaskColumn;
  priority: TaskPriority;
  category: string;
  tags: string[];
  backgroundTaskType: BackgroundTaskType;
  backgroundPrompt: string | null;
  researchReport: string | null;
  researchSources: Array<{ title: string; url: string }>;
  dueAt: string | null;
  reminderAt: string | null;
  reminderSentAt: string | null;
  discordChannelId: string | null;
  discordMessageId: string | null;
  discordThreadId: string | null;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends Task {
  checklist: ChecklistItem[];
  messages: TaskMessage[];
  attachments: TaskAttachment[];
  artifacts: TaskArtifact[];
  checkoutSessions: CheckoutSession[];
  fishbone: TaskFishbone | null;
}
