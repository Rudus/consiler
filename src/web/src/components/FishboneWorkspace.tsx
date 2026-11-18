import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Check,
  CheckCircle2,
  Circle,
  FileText,
  Link2,
  Loader2,
  Mail,
  Pin,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import { api } from '../api';
import type {
  ArtifactType,
  FishboneBone,
  FishboneOwner,
  TaskArtifact,
  TaskDetail,
} from '../types';
import { ArtifactCard } from './ArtifactCard';

interface FishboneWorkspaceProps {
  task: TaskDetail;
  mode: 'drawer' | 'fullpage';
  onUpdated: (task: TaskDetail) => void;
  onPrepareCheckout?: (
    taskId: string,
    artifactId: string,
    productUrl: string
  ) => void;
  onOpenFullPage?: () => void;
}

const OWNER_META: Record<
  FishboneOwner,
  { label: string; short: string; badgeClass: string; icon: React.ReactNode }
> = {
  ai: {
    label: 'Agent AI',
    short: 'AI',
    badgeClass: 'bg-[#DFE8EC] text-[#1D2529] border-[#C2CFD6]',
    icon: <Bot className="h-3 w-3 text-[#36566B]" />,
  },
  user: {
    label: 'Twój ruch',
    short: 'TY',
    badgeClass: 'bg-[#EFE6D2] text-[#2B251A] border-[#D6C9AD]',
    icon: <User className="h-3 w-3 text-[#9C6B30]" />,
  },
  shared: {
    label: 'Wspólnie (AI + Ty)',
    short: 'CO-OP',
    badgeClass: 'bg-[#E3EBDC] text-[#1F261D] border-[#C6D1BC]',
    icon: <Users className="h-3 w-3 text-[#3D6B5B]" />,
  },
};

export function FishboneWorkspace({
  task,
  mode,
  onUpdated,
  onPrepareCheckout,
  onOpenFullPage,
}: FishboneWorkspaceProps) {
  const [generating, setGenerating] = useState(false);
  const [customHint, setCustomHint] = useState('');
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [runningBoneId, setRunningBoneId] = useState<string | null>(null);
  const [newSubItemText, setNewSubItemText] = useState('');
  const [aiFollowupInput, setAiFollowupInput] = useState('');

  // Adding a new bone
  const [showAddBone, setShowAddBone] = useState(false);
  const [newBoneTitle, setNewBoneTitle] = useState('');
  const [newBoneDesc, setNewBoneDesc] = useState('');
  const [newBoneOwner, setNewBoneOwner] = useState<FishboneOwner>('shared');
  const [newBonePrompt, setNewBonePrompt] = useState('');

  // Adding an artifact directly to the selected bone
  const [showAddBoneArtifact, setShowAddBoneArtifact] = useState(false);
  const [artType, setArtType] = useState<ArtifactType>('link');
  const [artTitle, setArtTitle] = useState('');
  const [artUrl, setArtUrl] = useState('');
  const [artContent, setArtContent] = useState('');
  const [artPrice, setArtPrice] = useState('');

  const fishbone = task.fishbone;
  const bones = fishbone?.bones ?? [];

  useEffect(() => {
    if (!bones.length) {
      setSelectedBoneId(null);
      return;
    }
    if (selectedBoneId && bones.some((b) => b.id === selectedBoneId)) {
      return;
    }
    // Default to the first active bone (ai_working or needs_user) or the first bone
    const active =
      bones.find(
        (b) => b.status === 'needs_user' || b.status === 'ai_working'
      ) ??
      bones.find((b) => b.status !== 'done') ??
      bones[0];
    setSelectedBoneId(active?.id ?? null);
  }, [task.id, bones, selectedBoneId]);

  const selectedBone = useMemo(
    () => bones.find((b) => b.id === selectedBoneId) ?? bones[0] ?? null,
    [bones, selectedBoneId]
  );

  const artifactsByBone = useMemo(() => {
    const map = new Map<string, TaskArtifact[]>();
    for (const art of task.artifacts ?? []) {
      const bId = art.boneId || art.meta?.boneId;
      if (bId) {
        const list = map.get(bId) ?? [];
        list.push(art);
        map.set(bId, list);
      }
    }
    return map;
  }, [task.artifacts]);

  const unassignedArtifacts = useMemo(
    () =>
      (task.artifacts ?? []).filter(
        (art) => !art.boneId && !art.meta?.boneId
      ),
    [task.artifacts]
  );

  const handleGenerate = async (pinAsBigThing = false) => {
    setGenerating(true);
    try {
      const res = await api.generateFishbone(task.id, {
        customHint: customHint.trim() || undefined,
        pinAsBigThing,
      });
      onUpdated(res.task);
      setCustomHint('');
    } finally {
      setGenerating(false);
    }
  };

  const handleTogglePin = async () => {
    const nextPinned = !fishbone?.isPinnedBigThing;
    const res = await api.updateFishboneMeta(task.id, {
      isPinnedBigThing: nextPinned,
    });
    onUpdated(res.task);
  };

  const handleRunBoneAi = async (bone: FishboneBone, instruction?: string) => {
    setRunningBoneId(bone.id);
    try {
      await api.runFishboneBoneAi(task.id, bone.id, instruction);
      setAiFollowupInput('');
    } finally {
      setTimeout(() => setRunningBoneId(null), 900);
    }
  };

  // Empty State: Before Fishbone is generated
  if (!fishbone || bones.length === 0) {
    return (
      <div className="rounded-xl border border-[#DDD6C7] bg-[#FDFCF9] p-6 shadow-[0_2px_10px_rgba(31,30,27,0.03)] space-y-5">
        <div className="flex items-start justify-between gap-4 border-b border-[#EAE4D7] pb-4">
          <div>
            <div className="font-mono-spec text-[10px] tracking-[0.18em] uppercase text-[#8E897E] mb-1">
              FISH BONE · ANTI-PARALYSIS · CO-OP AI
            </div>
            <h3 className="font-serif-editorial text-xl text-[#1F1E1B]">
              Rozbij paraliżujące zadanie na kręgosłup i ości
            </h3>
            <p className="text-xs text-[#5C584F] mt-1 leading-relaxed max-w-xl">
              Zamiast długiej, przytłaczającej listy — rozpisz problem od{' '}
              <strong>Głowy (Cel)</strong> przez kolejne{' '}
              <strong>Ości (Etapy AI + Twoje decyzje + Artefakty)</strong> aż po{' '}
              <strong>Ogon (Finał)</strong>. AI automatycznie wykona swoje ości w
              tle i zatrzyma się tam, gdzie potrzebny jest Twój wybór.
            </p>
          </div>
        </div>

        {/* Mini Sketch Preview */}
        <div className="rounded-lg border border-dashed border-[#CFC8B8] bg-[#FAF8F3] p-4 flex flex-col sm:flex-row items-center gap-5">
          <svg
            viewBox="0 0 220 120"
            className="w-44 h-24 shrink-0 text-[#1F1E1B]"
            fill="none"
          >
            {/* Mini Fish Head */}
            <path
              d="M 18 32 L 26 36 L 22 24 C 38 12, 68 12, 82 24 L 46 66 C 30 56, 20 44, 18 32 Z"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="#F4F1EA"
            />
            <circle cx="58" cy="28" r="3.5" stroke="currentColor" strokeWidth="1.4" />
            {/* Spine */}
            <path
              d="M 64 46 Q 112 68 158 96"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            {/* Ribs */}
            <path d="M 82 55 Q 108 38 126 34" stroke="#4A7C6A" strokeWidth="1.4" />
            <circle cx="129" cy="33" r="3" fill="#4A7C6A" />
            <path d="M 102 66 Q 78 84 64 94" stroke="#4B6E84" strokeWidth="1.4" />
            <circle cx="61" cy="96" r="3" stroke="#4B6E84" strokeWidth="1.3" />
            <path d="M 125 78 Q 152 64 170 62" stroke="#9C6B30" strokeWidth="1.4" />
            <circle cx="173" cy="62" r="3" stroke="#9C6B30" strokeWidth="1.3" />
            {/* Tail */}
            <path
              d="M 158 96 L 136 112 C 154 112, 174 112, 194 106 L 158 96 Z"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="#F4F1EA"
            />
          </svg>

          <div className="flex-1 w-full space-y-3">
            <div>
              <label className="block font-mono-spec text-[10px] tracking-[0.12em] uppercase text-[#7A7468] mb-1">
                Opcjonalna wskazówka dla AI (np. na czym Ci najbardziej zależy)
              </label>
              <input
                type="text"
                value={customHint}
                onChange={(e) => setCustomHint(e.target.value)}
                placeholder="np. Najpierw sprawdź zamienniki do 200 zł, potem pomóż wybrać i przygotuj koszyk..."
                className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] placeholder:text-[#9A9488] focus:border-[#4A7C6A] focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={generating}
                onClick={() => void handleGenerate(mode === 'fullpage')}
                className="inline-flex items-center gap-2 rounded-md bg-[#1F1E1B] hover:bg-[#34322D] disabled:opacity-50 px-4 py-2 text-xs font-medium text-[#FAF8F3] transition shadow-sm"
              >
                {generating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-[#D8C39A]" />
                )}
                <span>
                  {generating
                    ? 'Rozpisywanie kręgosłupa i ości…'
                    : '🦴 Rozbij na rybią ość (AI + Ty)'}
                </span>
              </button>

              {mode === 'drawer' && (
                <button
                  type="button"
                  disabled={generating}
                  onClick={() => {
                    void handleGenerate(true).then(() => {
                      onOpenFullPage?.();
                    });
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#C6D1BC] bg-[#E3EBDC] hover:bg-[#D5E2C8] disabled:opacity-50 px-3 py-2 text-xs font-medium text-[#1F261D] transition"
                >
                  <Pin className="h-3.5 w-3.5" />
                  <span>Rozbij i przypnij jako „One Big Thing"</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const doneBonesCount = bones.filter((b) => b.status === 'done').length;
  const anyAiWorking = bones.some(
    (b) => b.status === 'ai_working' || runningBoneId === b.id
  );

  // Dynamic SVG coordinate calculation for 11 Friend Notebooks Fishbone diagram
  const svgWidth = 680;
  const boneStepY = 92;
  const firstBoneY = 175;
  const tailApexY = firstBoneY + Math.max(bones.length - 1, 1) * boneStepY + 80;
  const svgHeight = tailApexY + 95;

  const getSpineX = (y: number) => {
    const t = Math.max(
      0,
      Math.min(1, (y - 125) / Math.max(1, tailApexY - 125))
    );
    // Gentle S/arc curve from x=225 at head base to x=355 at tail apex
    return 225 + 130 * Math.pow(t, 0.85);
  };

  const selectedBoneArtifacts = selectedBone
    ? (artifactsByBone.get(selectedBone.id) ?? [])
    : [];

  return (
    <div className="space-y-5">
      {/* Top Toolbar: Progress Tracker & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#DDD6C7] pb-3">
        <div className="flex items-center gap-3">
          <div className="font-mono-spec text-[10px] tracking-[0.16em] uppercase text-[#7A7468]">
            POSTĘP OŚCI:
          </div>
          <div className="flex items-center gap-1">
            {bones.map((b, idx) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedBoneId(b.id)}
                title={`Ość ${idx + 1}: ${b.title} (${b.status})`}
                className={`h-5 w-5 rounded-[3px] border font-mono-spec text-[10px] flex items-center justify-center transition ${
                  b.status === 'done'
                    ? 'bg-[#4A7C6A] border-[#3D6B5B] text-[#FAF8F3]'
                    : b.status === 'ai_working'
                      ? 'bg-[#DFE8EC] border-[#4B6E84] text-[#1D2529] animate-pulse'
                      : b.status === 'needs_user'
                        ? 'bg-[#EFE6D2] border-[#9C6B30] text-[#2B251A] font-semibold'
                        : 'bg-[#FAF8F3] border-[#CFC8B8] text-[#8E897E]'
                } ${selectedBone?.id === b.id ? 'ring-2 ring-[#1F1E1B]/40' : ''}`}
              >
                {b.status === 'done' ? '✓' : idx + 1}
              </button>
            ))}
          </div>
          <span className="font-mono-spec text-[11px] text-[#5C584F]">
            {doneBonesCount}/{bones.length}
          </span>
          {anyAiWorking && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#DFE8EC] border border-[#C2CFD6] px-2.5 py-0.5 font-mono-spec text-[10px] text-[#2A4758]">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>AI pracuje nad ością…</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleTogglePin()}
            title="Przypnij to zadanie na pełnoekranowej karcie Today's One Big Thing"
            className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-[11px] font-medium transition ${
              fishbone.isPinnedBigThing
                ? 'border-[#C6D1BC] bg-[#E3EBDC] text-[#1F261D]'
                : 'border-[#DDD6C7] bg-[#FDFCF9] hover:bg-[#EFECE3] text-[#5C584F]'
            }`}
          >
            <Pin className="h-3 w-3" />
            <span>
              {fishbone.isPinnedBigThing
                ? 'Przypięte: One Big Thing'
                : 'Przypnij jako One Big Thing'}
            </span>
          </button>

          {mode === 'drawer' && onOpenFullPage && (
            <button
              type="button"
              onClick={onOpenFullPage}
              className="inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FDFCF9] hover:bg-[#EFECE3] px-2.5 py-1 text-[11px] text-[#1F1E1B] transition"
            >
              <span>Pełny arkusz A5 →</span>
            </button>
          )}

          <button
            type="button"
            disabled={generating}
            onClick={() => void handleGenerate(fishbone.isPinnedBigThing)}
            title="Wygeneruj układ ości od nowa przez AI"
            className="inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FDFCF9] hover:bg-[#EFECE3] disabled:opacity-50 px-2.5 py-1 text-[11px] text-[#5C584F] hover:text-[#1F1E1B] transition"
          >
            {generating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            <span>Przebuduj ość</span>
          </button>
        </div>
      </div>

      {/* Main Content Layout: 2 columns in fullpage mode, stacked in drawer mode */}
      <div
        className={
          mode === 'fullpage'
            ? 'grid grid-cols-1 lg:grid-cols-12 gap-6 items-start'
            : 'space-y-5'
        }
      >
        {/* LEFT / TOP: 11 Friend Notebooks Interactive Fishbone Sheet */}
        <div
          className={`${
            mode === 'fullpage' ? 'lg:col-span-7' : ''
          } relative rounded-xl border border-[#DDD6C7] bg-[#FDFCF9] p-4 sm:p-6 shadow-[0_4px_20px_rgba(31,30,27,0.05)] overflow-hidden`}
        >
          {/* Black Side Spine Tab from 11 Friend Notebooks */}
          <div
            className="hidden sm:flex absolute right-0 top-16 bg-[#1F1E1B] text-[#FAF8F3] px-1.5 py-3 font-mono-spec text-[9px] tracking-[0.25em] uppercase items-center justify-center select-none rounded-l"
            style={{ writingMode: 'vertical-rl' }}
          >
            SPINE •••
          </div>

          {/* Top Notebook Date & Habit/Stage Strip */}
          <div className="flex items-center justify-between border-b-2 border-[#1F1E1B]/70 pb-1.5 mb-2 font-mono-spec text-[9.5px] tracking-[0.16em] uppercase text-[#5C584F]">
            <div className="flex items-center gap-3">
              <span>DATE: {new Date(task.updatedAt).toLocaleDateString('pl-PL')}</span>
              <span className="hidden sm:inline text-[#9A9488]">
                MON · TUE · WED · THU · FRI · SAT · SUN
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span>STAGE TRACKER</span>
              <div className="inline-flex gap-0.5">
                {bones.map((b) => (
                  <span
                    key={b.id}
                    className={`inline-block w-3 h-3 border border-[#1F1E1B]/60 ${
                      b.status === 'done'
                        ? 'bg-[#4A7C6A]'
                        : b.status === 'needs_user'
                          ? 'bg-[#EFE6D2]'
                          : 'bg-transparent'
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* SVG FISHBONE GRAPH */}
          <div className="w-full overflow-x-auto">
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="w-full h-auto min-w-[520px] select-none"
            >
              <defs>
                <path
                  id="headArcPath"
                  d="M 78 58 C 122 24, 198 22, 252 46"
                />
              </defs>

              {/* 1. FISH HEAD ("TODAY'S ONE BIG THING") */}
              <g
                className="cursor-pointer"
                onClick={() => {
                  const nextHead = prompt(
                    'Główny cel / problem (Głowa ryby):',
                    fishbone.headGoal
                  );
                  if (nextHead && nextHead.trim()) {
                    void api
                      .updateFishboneMeta(task.id, {
                        headGoal: nextHead.trim(),
                      })
                      .then((res) => onUpdated(res.task));
                  }
                }}
              >
                <path
                  d="M 55 55 L 74 66 L 68 44 C 115 14, 206 14, 266 44 L 132 178 C 88 142, 64 98, 55 55 Z"
                  fill="#FAF8F3"
                  stroke="#1F1E1B"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                />
                {/* Fish Eye */}
                <circle
                  cx="198"
                  cy="68"
                  r="11"
                  fill="#FAF8F3"
                  stroke="#1F1E1B"
                  strokeWidth="1.65"
                />
                <circle cx="200" cy="67" r="3" fill="#1F1E1B" />

                {/* Curved "TODAY'S ONE BIG THING" along head top */}
                <text
                  fill="#8E897E"
                  fontSize="9.5"
                  letterSpacing="2.2"
                  className="font-mono-spec uppercase"
                >
                  <textPath href="#headArcPath" startOffset="4%">
                    TODAY&apos;S ONE BIG THING
                  </textPath>
                </text>

                {/* Head Goal Title Box next to / overlapping head */}
                <foreignObject x="76" y="78" width="175" height="72">
                  <div className="pr-2">
                    <div className="font-serif-editorial text-[13.5px] leading-snug text-[#1F1E1B] font-medium line-clamp-3">
                      {fishbone.headGoal}
                    </div>
                  </div>
                </foreignObject>
              </g>

              {/* 2. CURVED SPINE */}
              <path
                d={`M 225 125 Q 305 ${(125 + tailApexY) / 2} 355 ${tailApexY}`}
                fill="none"
                stroke="#1F1E1B"
                strokeWidth="2.1"
                strokeLinecap="round"
              />

              {/* 3. RIBS / BONES (Alternating Right & Left off the Spine) */}
              {bones.map((bone, index) => {
                const isRight = index % 2 === 0;
                const attachY = firstBoneY + index * boneStepY;
                const attachX = getSpineX(attachY);

                const tipX = isRight
                  ? Math.min(svgWidth - 195, attachX + 145)
                  : Math.max(185, attachX - 145);
                const tipY = isRight ? attachY - 34 : attachY + 26;
                const ctrlX = isRight ? attachX + 65 : attachX - 65;
                const ctrlY = isRight ? attachY - 36 : attachY - 12;

                const isSelected = selectedBone?.id === bone.id;
                const isDone = bone.status === 'done';
                const isWorking =
                  bone.status === 'ai_working' || runningBoneId === bone.id;
                const isNeedsUser = bone.status === 'needs_user';

                const strokeColor = isDone
                  ? '#4A7C6A'
                  : isWorking
                    ? '#4B6E84'
                    : isNeedsUser
                      ? '#9C6B30'
                      : '#36332D';

                const boneArts = artifactsByBone.get(bone.id) ?? [];
                const ownerInfo = OWNER_META[bone.owner] ?? OWNER_META.user;

                // Card box placement near the rib tip
                const boxX = isRight ? tipX + 14 : Math.max(8, tipX - 184);
                const boxY = tipY - 34;

                return (
                  <g
                    key={bone.id}
                    className="cursor-pointer group"
                    onClick={() => setSelectedBoneId(bone.id)}
                  >
                    {/* Highlight halo when bone is selected */}
                    {isSelected && (
                      <path
                        d={`M ${attachX} ${attachY} Q ${ctrlX} ${ctrlY} ${tipX} ${tipY}`}
                        fill="none"
                        stroke="#4A7C6A"
                        strokeOpacity="0.22"
                        strokeWidth="10"
                        strokeLinecap="round"
                      />
                    )}

                    {/* Rib Curve */}
                    <path
                      d={`M ${attachX} ${attachY} Q ${ctrlX} ${ctrlY} ${tipX} ${tipY}`}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={isSelected ? '2.4' : '1.65'}
                      strokeDasharray={
                        bone.status === 'pending' ? '4 3' : undefined
                      }
                      strokeLinecap="round"
                    />

                    {/* Spine Node Junction */}
                    <circle
                      cx={attachX}
                      cy={attachY}
                      r="3.5"
                      fill={isDone ? '#4A7C6A' : '#FAF8F3'}
                      stroke={strokeColor}
                      strokeWidth="1.6"
                    />

                    {/* Signature Teardrop Loop at Rib Tip */}
                    <circle
                      cx={tipX}
                      cy={tipY}
                      r="7.5"
                      fill={
                        isDone
                          ? '#4A7C6A'
                          : isNeedsUser
                            ? '#EFE6D2'
                            : isWorking
                              ? '#DFE8EC'
                              : '#FAF8F3'
                      }
                      stroke={strokeColor}
                      strokeWidth="1.75"
                    />
                    {isDone && (
                      <text
                        x={tipX}
                        y={tipY + 3.5}
                        textAnchor="middle"
                        fontSize="10"
                        fill="#FAF8F3"
                        fontWeight="bold"
                      >
                        ✓
                      </text>
                    )}
                    {!isDone && (
                      <text
                        x={tipX}
                        y={tipY + 3.2}
                        textAnchor="middle"
                        fontSize="8.5"
                        fill={strokeColor}
                        className="font-mono-spec"
                      >
                        {index + 1}
                      </text>
                    )}

                    {/* "STEP 0X · AI/TY" label along the rib */}
                    <text
                      x={(attachX + tipX) / 2}
                      y={(attachY + tipY) / 2 - 8}
                      textAnchor="middle"
                      fontSize="8.5"
                      letterSpacing="1.4"
                      fill="#8E897E"
                      className="font-mono-spec uppercase"
                    >
                      STEP 0{index + 1} · {ownerInfo.short}
                    </text>

                    {/* Interactive Label & Attached Artifact Badges right on the Bone */}
                    <foreignObject
                      x={boxX}
                      y={boxY}
                      width="172"
                      height="98"
                    >
                      <div
                        className={`rounded-lg border p-2 transition text-left ${
                          isSelected
                            ? 'border-[#1F1E1B] bg-[#FDFCF9] shadow-[0_2px_8px_rgba(31,30,27,0.08)]'
                            : isNeedsUser
                              ? 'border-[#D6C9AD] bg-[#EFE6D2]/60 hover:border-[#9C6B30]'
                              : isDone
                                ? 'border-[#C6D1BC] bg-[#E3EBDC]/45'
                                : 'border-[#DDD6C7] bg-[#FAF8F3]/95 hover:border-[#BFB6A4]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1 mb-0.5">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded border font-mono-spec text-[8px] uppercase ${ownerInfo.badgeClass}`}
                          >
                            {ownerInfo.short}
                          </span>
                          <span className="font-mono-spec text-[8px] uppercase text-[#7A7468]">
                            {isDone
                              ? 'GOTOWE'
                              : isWorking
                                ? 'AI PRACUJE…'
                                : isNeedsUser
                                  ? 'TWÓJ RUCH'
                                  : 'OCZEKUJE'}
                          </span>
                        </div>

                        <div
                          className={`text-[11px] font-medium leading-tight line-clamp-2 ${
                            isDone
                              ? 'line-through text-[#6E7368]'
                              : 'text-[#1F1E1B]'
                          }`}
                        >
                          {bone.title}
                        </div>

                        {/* Artifact chips directly on the bone! */}
                        {boneArts.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {boneArts.slice(0, 2).map((art) => {
                              const isChosen =
                                bone.selectedArtifactId === art.id;
                              return (
                                <span
                                  key={art.id}
                                  title={`${art.title}${art.meta?.price ? ` (${art.meta.price})` : ''}`}
                                  className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono-spec text-[8.5px] truncate max-w-[152px] border ${
                                    isChosen
                                      ? 'bg-[#4A7C6A] text-[#FAF8F3] border-[#3D6B5B] font-semibold'
                                      : 'bg-[#E8EFF3] text-[#2A4758] border-[#C5D4DE]'
                                  }`}
                                >
                                  {isChosen
                                    ? '★ '
                                    : art.type === 'link'
                                      ? '🔗 '
                                      : art.type === 'message'
                                        ? '✉️ '
                                        : '📝 '}
                                  <span className="truncate">
                                    {art.meta?.price
                                      ? `${art.meta.price} · ${art.title}`
                                      : art.title}
                                  </span>
                                </span>
                              );
                            })}
                            {boneArts.length > 2 && (
                              <span className="font-mono-spec text-[8px] text-[#7A7468] px-1">
                                +{boneArts.length - 2}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </foreignObject>
                  </g>
                );
              })}

              {/* 4. FISH TAIL ("TAIL END") */}
              <g
                className="cursor-pointer"
                onClick={() => {
                  const nextTail = prompt(
                    'Definicja ukończenia / stan końcowy (Ogon ryby):',
                    fishbone.tailOutcome
                  );
                  if (nextTail && nextTail.trim()) {
                    void api
                      .updateFishboneMeta(task.id, {
                        tailOutcome: nextTail.trim(),
                      })
                      .then((res) => onUpdated(res.task));
                  }
                }}
              >
                <path
                  d={`M 355 ${tailApexY} C 280 ${tailApexY + 14}, 235 ${tailApexY + 46}, 218 ${tailApexY + 72} C 265 ${tailApexY + 54}, 315 ${tailApexY + 52}, 344 ${tailApexY + 58} L 352 ${tailApexY + 44} L 362 ${tailApexY + 58} C 402 ${tailApexY + 50}, 456 ${tailApexY + 50}, 502 ${tailApexY + 62} C 478 ${tailApexY + 32}, 424 ${tailApexY + 10}, 355 ${tailApexY} Z`}
                  fill={
                    doneBonesCount === bones.length && bones.length > 0
                      ? '#E3EBDC'
                      : '#FAF8F3'
                  }
                  stroke="#1F1E1B"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                />
                <text
                  x="395"
                  y={tailApexY + 46}
                  fontSize="9"
                  letterSpacing="1.8"
                  fill="#8E897E"
                  className="font-mono-spec uppercase"
                >
                  TAIL END
                </text>
                <foreignObject
                  x="235"
                  y={tailApexY + 15}
                  width="240"
                  height="32"
                >
                  <div className="text-center font-serif-editorial italic text-xs text-[#1F1E1B] truncate px-2">
                    {fishbone.tailOutcome}
                  </div>
                </foreignObject>
              </g>
            </svg>
          </div>

          {/* Add Bone Quick Trigger & 11 Friend Notebooks Footer Box */}
          <div className="mt-3 pt-3 border-t border-[#EAE4D7] flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowAddBone((v) => !v)}
              className="inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FAF8F3] hover:bg-[#EFECE3] px-2.5 py-1 text-[11px] text-[#36332D] transition"
            >
              <Plus className="h-3 w-3" />
              <span>Dodaj ość do kręgosłupa</span>
            </button>

            <span className="font-mono-spec text-[9.5px] tracking-[0.12em] uppercase text-[#8E897E]">
              Kliknij w dowolną ość na rysunku, aby pracować nad jej artefaktami
            </span>
          </div>

          {showAddBone && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newBoneTitle.trim()) return;
                const res = await api.addFishboneBone(task.id, {
                  title: newBoneTitle.trim(),
                  description: newBoneDesc.trim(),
                  owner: newBoneOwner,
                  aiPrompt:
                    newBoneOwner !== 'user' && newBonePrompt.trim()
                      ? newBonePrompt.trim()
                      : null,
                });
                onUpdated(res.task);
                setNewBoneTitle('');
                setNewBoneDesc('');
                setNewBonePrompt('');
                setShowAddBone(false);
              }}
              className="mt-3 rounded-lg border border-[#DDD6C7] bg-[#FAF8F3] p-3.5 space-y-2.5"
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  value={newBoneOwner}
                  onChange={(e) =>
                    setNewBoneOwner(e.target.value as FishboneOwner)
                  }
                  className="rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2 py-1.5 text-xs text-[#1F1E1B]"
                >
                  <option value="shared">🤝 Wspólna (AI + Ty)</option>
                  <option value="ai">🤖 Agent AI (w tle)</option>
                  <option value="user">👤 Twój krok</option>
                </select>
                <input
                  type="text"
                  value={newBoneTitle}
                  onChange={(e) => setNewBoneTitle(e.target.value)}
                  placeholder="Nazwa etapu / ości..."
                  required
                  className="sm:col-span-2 rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2.5 py-1.5 text-xs text-[#1F1E1B]"
                />
              </div>
              <input
                type="text"
                value={newBoneDesc}
                onChange={(e) => setNewBoneDesc(e.target.value)}
                placeholder="Krótki opis co należy zrobić na tej ości..."
                className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2.5 py-1.5 text-xs text-[#1F1E1B]"
              />
              {newBoneOwner !== 'user' && (
                <input
                  type="text"
                  value={newBonePrompt}
                  onChange={(e) => setNewBonePrompt(e.target.value)}
                  placeholder="Instrukcja dla AI na tej ości (np. porównaj oferty, napisz pismo)..."
                  className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2.5 py-1.5 text-xs text-[#1F1E1B]"
                />
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddBone(false)}
                  className="px-2.5 py-1 text-xs text-[#7A7468]"
                >
                  Anuluj
                </button>
                <button
                  type="submit"
                  className="rounded bg-[#1F1E1B] px-3 py-1 text-xs font-medium text-[#FAF8F3]"
                >
                  Dodaj ość
                </button>
              </div>
            </form>
          )}

          {/* 11 Friend Notebooks Signature Anti-Paralysis Box */}
          <div className="mt-4 border border-[#1F1E1B] rounded-sm overflow-hidden text-xs">
            <div className="flex items-stretch border-b border-[#1F1E1B]">
              <div className="px-2 py-1 border-r border-[#1F1E1B] font-mono-spec text-[10px] flex items-center">
                ⋮
              </div>
              <div className="bg-[#1F1E1B] text-[#FAF8F3] px-3 py-1 font-mono-spec text-[10px] tracking-[0.18em] uppercase flex items-center">
                FISH BONE
              </div>
              <div className="px-3 py-1 font-mono-spec text-[9.5px] tracking-[0.14em] uppercase text-[#1F1E1B] flex items-center">
                ANTI-PARALYSIS • BREAK ONE BIG TASK INTO BITES
              </div>
            </div>
            <div className="px-3 py-2 bg-[#FAF8F3] font-mono-spec text-[10.5px] text-[#36332D] leading-relaxed">
              Nazwij główne wyzwanie w głowie ryby, a potem rozbij je na mniejsze
              ości wzdłuż kręgosłupa. Artefakty i warianty wypracowane przez AI
              pojawiają się bezpośrednio na ościach — Twój wybór odblokowuje
              kolejne etapy.
            </div>
          </div>
        </div>

        {/* RIGHT / BOTTOM: Active Bone Workbench + Attached Artifacts */}
        {selectedBone && (
          <div
            className={`${
              mode === 'fullpage' ? 'lg:col-span-5' : ''
            } rounded-xl border border-[#DDD6C7] bg-[#FDFCF9] p-5 shadow-[0_4px_20px_rgba(31,30,27,0.05)] space-y-4`}
          >
            {/* Bone Header */}
            <div className="flex items-start justify-between gap-3 border-b border-[#EAE4D7] pb-3.5">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono-spec text-[10px] tracking-[0.16em] uppercase text-[#8E897E]">
                    OŚĆ #{selectedBone.position + 1} Z {bones.length}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono-spec text-[9.5px] uppercase ${
                      OWNER_META[selectedBone.owner].badgeClass
                    }`}
                  >
                    {OWNER_META[selectedBone.owner].icon}
                    <span>{OWNER_META[selectedBone.owner].label}</span>
                  </span>
                </div>
                <h3 className="font-serif-editorial text-xl text-[#1F1E1B] leading-snug">
                  {selectedBone.title}
                </h3>
                {selectedBone.description && (
                  <p className="text-xs text-[#5C584F] leading-relaxed">
                    {selectedBone.description}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    void api
                      .updateFishboneBone(task.id, selectedBone.id, {
                        status:
                          selectedBone.status === 'done'
                            ? 'needs_user'
                            : 'done',
                      })
                      .then((res) => onUpdated(res.task))
                  }
                  className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs font-medium transition ${
                    selectedBone.status === 'done'
                      ? 'border-[#4A7C6A] bg-[#4A7C6A] text-[#FAF8F3]'
                      : 'border-[#C6D1BC] bg-[#E3EBDC] hover:bg-[#D5E2C8] text-[#1F261D]'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>
                    {selectedBone.status === 'done'
                      ? 'Etap ukończony'
                      : 'Zatwierdź ość'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (!confirm('Usunąć tę ość z kręgosłupa?')) return;
                    void api
                      .deleteFishboneBone(task.id, selectedBone.id)
                      .then((res) => onUpdated(res.task));
                  }}
                  title="Usuń tę ość"
                  className="rounded p-1.5 text-[#8E897E] hover:text-[#A94B3E] hover:bg-[#EFECE3] transition"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* AI Work Result on this Bone */}
            {(selectedBone.aiResult ||
              selectedBone.status === 'ai_working' ||
              runningBoneId === selectedBone.id ||
              selectedBone.owner !== 'user') && (
              <div className="rounded-lg border border-[#C2CFD6] bg-[#DFE8EC]/35 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="inline-flex items-center gap-1.5 font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#2A4758]">
                    <Bot className="h-3.5 w-3.5" />
                    <span>Ustalenia AI na tej ości</span>
                  </div>

                  <button
                    type="button"
                    disabled={
                      selectedBone.status === 'ai_working' ||
                      runningBoneId === selectedBone.id
                    }
                    onClick={() => void handleRunBoneAi(selectedBone)}
                    className="inline-flex items-center gap-1 rounded border border-[#C2CFD6] bg-[#FDFCF9] hover:bg-[#E8EFF3] disabled:opacity-50 px-2 py-0.5 text-[10.5px] font-medium text-[#2A4758] transition"
                  >
                    {selectedBone.status === 'ai_working' ||
                    runningBoneId === selectedBone.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    <span>
                      {selectedBone.aiResult ? 'Odśwież AI' : 'Uruchom AI'}
                    </span>
                  </button>
                </div>

                {selectedBone.status === 'ai_working' ||
                runningBoneId === selectedBone.id ? (
                  <div className="flex items-center gap-2 text-xs text-[#2A4758] py-2">
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    <span>
                      Agent AI analizuje ten etap i przygotowuje artefakty dla
                      ości…
                    </span>
                  </div>
                ) : selectedBone.aiResult ? (
                  <div className="prose prose-sm max-w-none text-xs text-[#1F1E1B]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {selectedBone.aiResult}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-xs text-[#5C584F]">
                    AI nie wykonało jeszcze pracy na tej ości. Kliknij{' '}
                    <strong>Uruchom AI</strong> albo zatwierdź poprzedni etap.
                  </p>
                )}

                {/* Quick instruction to AI for this specific bone */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!aiFollowupInput.trim()) return;
                    void handleRunBoneAi(
                      selectedBone,
                      aiFollowupInput.trim()
                    );
                  }}
                  className="flex gap-1.5 pt-1"
                >
                  <input
                    type="text"
                    value={aiFollowupInput}
                    onChange={(e) => setAiFollowupInput(e.target.value)}
                    placeholder="Doprecyzuj zadanie dla AI na tej ości..."
                    className="flex-1 rounded border border-[#C2CFD6] bg-[#FDFCF9] px-2.5 py-1 text-xs text-[#1F1E1B] placeholder:text-[#8E897E] focus:border-[#4B6E84] focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={
                      !aiFollowupInput.trim() ||
                      selectedBone.status === 'ai_working'
                    }
                    className="rounded bg-[#2A4758] hover:bg-[#1D3542] disabled:opacity-40 px-2.5 py-1 text-[11px] font-medium text-[#FAF8F3] transition"
                  >
                    Zleć AI
                  </button>
                </form>
              </div>
            )}

            {/* ARTIFACTS ATTACHED DIRECTLY TO THIS BONE */}
            <section className="space-y-2.5">
              <div className="flex items-center justify-between border-b border-[#EAE4D7] pb-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#4A7C6A]">
                    🦴 Artefakty na tej ości ({selectedBoneArtifacts.length})
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowAddBoneArtifact((v) => !v)}
                  className="inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FAF8F3] hover:bg-[#EFECE3] px-2 py-0.5 text-[10.5px] text-[#36332D] transition"
                >
                  <Plus className="h-3 w-3" />
                  <span>Dodaj artefakt</span>
                </button>
              </div>

              {showAddBoneArtifact && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!artTitle.trim()) return;
                    const meta: Record<string, string> = {};
                    if (artPrice.trim()) meta.price = artPrice.trim();
                    const res = await api.addArtifact(task.id, {
                      type: artType,
                      title: artTitle.trim(),
                      content: artContent.trim(),
                      url:
                        artType === 'link' && artUrl.trim()
                          ? artUrl.trim()
                          : null,
                      boneId: selectedBone.id,
                      meta,
                    });
                    onUpdated(res.task);
                    setArtTitle('');
                    setArtUrl('');
                    setArtContent('');
                    setArtPrice('');
                    setShowAddBoneArtifact(false);
                  }}
                  className="rounded-lg border border-[#DDD6C7] bg-[#FAF8F3] p-3 space-y-2"
                >
                  <div className="grid grid-cols-3 gap-2">
                    <select
                      value={artType}
                      onChange={(e) =>
                        setArtType(e.target.value as ArtifactType)
                      }
                      className="rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2 py-1 text-xs text-[#1F1E1B]"
                    >
                      <option value="link">Link / Oferta</option>
                      <option value="message">Wiadomość</option>
                      <option value="note">Notatka</option>
                    </select>
                    <input
                      type="text"
                      value={artTitle}
                      onChange={(e) => setArtTitle(e.target.value)}
                      placeholder="Tytuł artefaktu na ości..."
                      required
                      className="col-span-2 rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2.5 py-1 text-xs text-[#1F1E1B]"
                    />
                  </div>
                  {artType === 'link' && (
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        type="url"
                        value={artUrl}
                        onChange={(e) => setArtUrl(e.target.value)}
                        placeholder="https://..."
                        className="col-span-2 rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2.5 py-1 text-xs text-[#1F1E1B]"
                      />
                      <input
                        type="text"
                        value={artPrice}
                        onChange={(e) => setArtPrice(e.target.value)}
                        placeholder="Cena (np. 149 zł)"
                        className="rounded border border-[#DDD6C7] bg-[#FDFCF9] px-2.5 py-1 text-xs text-[#1F1E1B]"
                      />
                    </div>
                  )}
                  <textarea
                    value={artContent}
                    onChange={(e) => setArtContent(e.target.value)}
                    rows={2}
                    placeholder="Treść wiadomości, opis oferty lub notatka..."
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] p-2 text-xs text-[#1F1E1B] resize-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddBoneArtifact(false)}
                      className="text-xs text-[#7A7468] px-2 py-1"
                    >
                      Anuluj
                    </button>
                    <button
                      type="submit"
                      className="rounded bg-[#1F1E1B] px-3 py-1 text-xs font-medium text-[#FAF8F3]"
                    >
                      Przypnij do ości
                    </button>
                  </div>
                </form>
              )}

              {selectedBoneArtifacts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#DDD6C7] bg-[#FAF8F3]/70 p-3 text-xs text-[#7A7468]">
                  Brak artefaktów przypiętych do tej ości. Gdy AI znajdzie
                  oferty lub przygotuje szkic na tym etapie, pojawią się tutaj.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {selectedBoneArtifacts.map((art) => {
                    const cs = task.checkoutSessions?.find(
                      (s) => s.artifactId === art.id || s.productUrl === art.url
                    );
                    const isSelectedVariant =
                      selectedBone.selectedArtifactId === art.id;
                    return (
                      <ArtifactCard
                        key={art.id}
                        artifact={art}
                        checkoutSession={cs}
                        isSelectedVariant={isSelectedVariant}
                        onSelectAsVariant={() =>
                          void api
                            .updateFishboneBone(task.id, selectedBone.id, {
                              selectedArtifactId: isSelectedVariant
                                ? null
                                : art.id,
                            })
                            .then((res) => onUpdated(res.task))
                        }
                        onPrepareCheckout={
                          art.type === 'link' && art.url && onPrepareCheckout
                            ? () =>
                                onPrepareCheckout(task.id, art.id, art.url!)
                            : undefined
                        }
                        onDetachFromBone={() =>
                          void api
                            .assignArtifactToBone(task.id, art.id, null)
                            .then((res) => onUpdated(res.task))
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

              {/* Quick attach existing unassigned artifacts to this bone */}
              {unassignedArtifacts.length > 0 && (
                <div className="pt-1">
                  <div className="font-mono-spec text-[9.5px] tracking-[0.12em] uppercase text-[#8E897E] mb-1.5">
                    Przypnij istniejący artefakt zadania do tej ości:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {unassignedArtifacts.map((art) => (
                      <button
                        key={art.id}
                        type="button"
                        onClick={() =>
                          void api
                            .assignArtifactToBone(
                              task.id,
                              art.id,
                              selectedBone.id
                            )
                            .then((res) => onUpdated(res.task))
                        }
                        className="inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FAF8F3] hover:border-[#4A7C6A] hover:bg-[#E8F0EC] px-2 py-1 text-[11px] text-[#36332D] transition max-w-[240px] truncate"
                      >
                        {art.type === 'link' ? (
                          <Link2 className="h-3 w-3 shrink-0 text-[#4B6E84]" />
                        ) : art.type === 'message' ? (
                          <Mail className="h-3 w-3 shrink-0 text-[#4A7C6A]" />
                        ) : (
                          <FileText className="h-3 w-3 shrink-0 text-[#9C6B30]" />
                        )}
                        <span className="truncate">+ {art.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* SUB-STEPS & DECISION VARIANTS ON THIS BONE */}
            <section className="space-y-2">
              <div className="font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#7A7468] border-b border-[#EAE4D7] pb-1">
                Pod-kroki i warianty decyzyjne na tej ości
              </div>

              <div className="divide-y divide-[#EFECE3]">
                {selectedBone.subItems.map((sub) => (
                  <div
                    key={sub.id}
                    className="flex items-start justify-between gap-2.5 py-2"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        void api
                          .updateFishboneBone(
                            task.id,
                            selectedBone.id,
                            sub.isOption
                              ? { selectSubItemId: sub.id }
                              : { toggleSubItemId: sub.id }
                          )
                          .then((res) => onUpdated(res.task))
                      }
                      className="flex items-start gap-2 text-left flex-1 group"
                    >
                      {sub.completed || sub.selected ? (
                        <CheckCircle2 className="h-4 w-4 text-[#4A7C6A] shrink-0 mt-0.5" />
                      ) : (
                        <Circle className="h-4 w-4 text-[#8E897E] group-hover:text-[#4A7C6A] shrink-0 mt-0.5" />
                      )}
                      <span
                        className={`text-xs leading-relaxed ${
                          sub.selected
                            ? 'font-semibold text-[#244337]'
                            : sub.completed
                              ? 'line-through text-[#9A9488]'
                              : 'text-[#1F1E1B]'
                        }`}
                      >
                        {sub.text}
                      </span>
                    </button>

                    {sub.isOption && (
                      <button
                        type="button"
                        onClick={() =>
                          void api
                            .updateFishboneBone(task.id, selectedBone.id, {
                              selectSubItemId: sub.id,
                            })
                            .then((res) => onUpdated(res.task))
                        }
                        className={`shrink-0 rounded border px-2 py-0.5 font-mono-spec text-[9.5px] uppercase transition ${
                          sub.selected
                            ? 'bg-[#4A7C6A] border-[#3D6B5B] text-[#FAF8F3]'
                            : 'bg-[#FAF8F3] border-[#DDD6C7] hover:bg-[#E3EBDC] text-[#36332D]'
                        }`}
                      >
                        {sub.selected ? '★ Wybrano' : 'Wybierz opcję'}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newSubItemText.trim()) return;
                  const txt = newSubItemText.trim();
                  setNewSubItemText('');
                  void api
                    .updateFishboneBone(task.id, selectedBone.id, {
                      addSubItemText: txt,
                    })
                    .then((res) => onUpdated(res.task));
                }}
                className="flex gap-2 pt-1"
              >
                <input
                  type="text"
                  value={newSubItemText}
                  onChange={(e) => setNewSubItemText(e.target.value)}
                  placeholder="Dodaj pod-krok do tej ości..."
                  className="flex-1 border-b border-[#DDD6C7] focus:border-[#4A7C6A] bg-transparent px-1 py-1 text-xs text-[#1F1E1B] placeholder:text-[#9A9488] focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded border border-[#DDD6C7] bg-[#FAF8F3] hover:bg-[#EFECE3] px-2 py-1 text-xs text-[#5C584F]"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </form>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
