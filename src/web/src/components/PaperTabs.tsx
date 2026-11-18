import React from 'react';

export type PaperTabTone = 'sage' | 'blue' | 'ochre' | 'parchment' | 'sand';

const TONE_STYLES: Record<
  PaperTabTone,
  { active: string; inactive: string }
> = {
  sage: {
    active: 'bg-[#E3EBDC] border-[#C6D1BC] text-[#1F261D]',
    inactive: 'bg-[#E3EBDC]/45 border-[#D7DDD0] text-[#6E7368] hover:bg-[#E3EBDC]/75 hover:text-[#2D352B]',
  },
  blue: {
    active: 'bg-[#DFE8EC] border-[#C2CFD6] text-[#1D2529]',
    inactive: 'bg-[#DFE8EC]/45 border-[#D2DBE0] text-[#687278] hover:bg-[#DFE8EC]/75 hover:text-[#2A343A]',
  },
  ochre: {
    active: 'bg-[#EFE6D2] border-[#D6C9AD] text-[#2B251A]',
    inactive: 'bg-[#EFE6D2]/45 border-[#DFD7C4] text-[#786F5F] hover:bg-[#EFE6D2]/75 hover:text-[#3A3224]',
  },
  parchment: {
    active: 'bg-[#EAE4D6] border-[#CEC6B4] text-[#1F1E1B]',
    inactive: 'bg-[#EAE4D6]/45 border-[#DDD7C9] text-[#7A7468] hover:bg-[#EAE4D6]/75 hover:text-[#36332D]',
  },
  sand: {
    active: 'bg-[#EFE3DC] border-[#D7C4BA] text-[#2B211E]',
    inactive: 'bg-[#EFE3DC]/45 border-[#E2D5CE] text-[#796B65] hover:bg-[#EFE3DC]/75 hover:text-[#3B2E29]',
  },
};

interface PaperTabProps {
  active: boolean;
  tone: PaperTabTone;
  onClick: () => void;
  size?: 'sm' | 'md';
  children: React.ReactNode;
}

export function PaperTab({
  active,
  tone,
  onClick,
  size = 'md',
  children,
}: PaperTabProps) {
  const palette = TONE_STYLES[tone];
  const sizing =
    size === 'sm'
      ? 'px-2.5 py-1 text-[9.5px] tracking-[0.14em]'
      : 'px-3.5 py-1.5 text-[10px] tracking-[0.16em]';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-mono-spec uppercase inline-flex items-center gap-1.5 rounded-t-[6px] border border-b-0 transition-all select-none ${sizing} ${
        active
          ? `${palette.active} font-medium -mb-px pb-[7px] shadow-[0_-1px_2px_rgba(31,30,27,0.03)] relative z-10`
          : `${palette.inactive}`
      }`}
    >
      {children}
    </button>
  );
}
