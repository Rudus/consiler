import { useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Mail,
  ShoppingCart,
  Trash2,
} from 'lucide-react';
import type { CheckoutSession, TaskArtifact } from '../types';
import { CHECKOUT_STATUS_LABEL } from './CheckoutSessionCard';

interface ArtifactCardProps {
  artifact: TaskArtifact;
  checkoutSession?: CheckoutSession | null;
  taskTitle?: string;
  boneLabel?: string | null;
  isSelectedVariant?: boolean;
  onSelectAsVariant?: () => void;
  onOpenTask?: () => void;
  onPrepareCheckout?: () => void;
  onDetachFromBone?: () => void;
  onDelete?: () => void;
}

export function ArtifactCard({
  artifact,
  checkoutSession,
  taskTitle,
  boneLabel,
  isSelectedVariant,
  onSelectAsVariant,
  onOpenTask,
  onPrepareCheckout,
  onDetachFromBone,
  onDelete,
}: ArtifactCardProps) {
  const [copied, setCopied] = useState(false);

  const copyText =
    artifact.type === 'link'
      ? artifact.url || artifact.content
      : artifact.content || artifact.title;

  const handleCopy = async () => {
    if (!copyText) return;
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const icon =
    artifact.type === 'link' ? (
      <Link2 className="h-3 w-3 text-[#4B6E84]" />
    ) : artifact.type === 'message' ? (
      <Mail className="h-3 w-3 text-[#4A7C6A]" />
    ) : (
      <FileText className="h-3 w-3 text-[#9C6B30]" />
    );

  const typeLabel =
    artifact.type === 'link'
      ? 'LINK / OFERTA'
      : artifact.type === 'message'
        ? 'WIADOMOŚĆ'
        : 'NOTATKA';

  const price = artifact.meta?.price;
  const platform = artifact.meta?.platform;
  const status = artifact.meta?.status;

  return (
    <div
      className={`rounded-lg border p-3.5 space-y-2.5 transition shadow-[0_1px_2px_rgba(31,30,27,0.03)] ${
        isSelectedVariant
          ? 'border-[#4A7C6A] bg-[#F3F8F5] ring-1 ring-[#4A7C6A]/35'
          : 'border-[#DDD6C7] bg-[#FAF8F3] hover:border-[#BFB6A4] hover:bg-[#FDFCF9]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1 font-mono-spec text-[9.5px] tracking-[0.12em] uppercase">
            <span className="inline-flex items-center gap-1 text-[#7A7468]">
              {icon}
              {typeLabel}
            </span>
            {boneLabel && (
              <span className="text-[#5C584F] bg-[#EFECE3] border border-[#DDD6C7] px-1.5 py-0.5 rounded">
                🦴 {boneLabel}
              </span>
            )}
            {isSelectedVariant && (
              <span className="font-semibold text-[#FAF8F3] bg-[#4A7C6A] px-1.5 py-0.5 rounded">
                ★ WYBRANY WARIANT
              </span>
            )}
            {platform && (
              <span className="text-[#4B6E84]">· {platform}</span>
            )}
            {price && (
              <span className="font-semibold text-[#3D6B5B] bg-[#E8F0EC] px-1.5 py-0.5 rounded">
                {price}
              </span>
            )}
            {status && (
              <span className="text-[#8E897E]">· {status}</span>
            )}
            {checkoutSession && (
              <span className="font-semibold text-[#244337] bg-[#E3EBDC] border border-[#C6D1BC] px-1.5 py-0.5 rounded">
                🛒 {CHECKOUT_STATUS_LABEL[checkoutSession.status] ?? checkoutSession.status}
                {checkoutSession.detectedTotal ? ` · ${checkoutSession.detectedTotal}` : ''}
              </span>
            )}
          </div>
          <h4 className="text-[13.5px] font-medium text-[#1F1E1B] leading-snug">
            {artifact.title}
          </h4>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
          {onSelectAsVariant && (
            <button
              type="button"
              onClick={onSelectAsVariant}
              title={
                isSelectedVariant
                  ? 'Ten artefakt został wybrany jako docelowy wariant na tej ości'
                  : 'Wybierz ten artefakt jako docelowy wariant i odblokuj kolejne ości AI'
              }
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium transition ${
                isSelectedVariant
                  ? 'border-[#4A7C6A] bg-[#4A7C6A] text-[#FAF8F3]'
                  : 'border-[#C6D1BC] bg-[#FDFCF9] hover:bg-[#E3EBDC] text-[#244337]'
              }`}
            >
              <Check className="h-3 w-3" />
              <span>{isSelectedVariant ? 'Wybrano' : 'Wybierz wariant'}</span>
            </button>
          )}
          {artifact.type === 'link' && artifact.url && onPrepareCheckout && (
            <button
              type="button"
              onClick={onPrepareCheckout}
              title="Dodaj do koszyka i wypełnij dane dostawy (zatrzyma się przed płatnością)"
              className="inline-flex items-center gap-1 rounded border border-[#C6D1BC] bg-[#E3EBDC] hover:bg-[#D5E2C8] px-2 py-1 text-[11px] font-medium text-[#244337] transition"
            >
              <ShoppingCart className="h-3 w-3" />
              <span>Przygotuj zakup</span>
            </button>
          )}
          {artifact.url && (
            <a
              href={artifact.url}
              target="_blank"
              rel="noreferrer"
              title="Otwórz link"
              className="inline-flex items-center gap-1 rounded border border-[#C5D4DE] bg-[#E8EFF3] hover:bg-[#DCE7EE] px-2 py-1 text-[11px] font-medium text-[#36566B] transition"
            >
              <ExternalLink className="h-3 w-3" />
              <span>Otwórz</span>
            </a>
          )}
          {copyText && (
            <button
              type="button"
              onClick={handleCopy}
              title="Kopiuj do schowka"
              className="inline-flex items-center gap-1 rounded border border-[#DDD6C7] bg-[#FDFCF9] hover:bg-[#EFECE3] px-2 py-1 text-[11px] text-[#36332D] transition"
            >
              {copied ? (
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
          {onDetachFromBone && (
            <button
              type="button"
              onClick={onDetachFromBone}
              title="Odepnij z tej ości (zostanie w ogólnych artefaktach)"
              className="rounded border border-[#DDD6C7] bg-[#FAF8F3] hover:bg-[#EFECE3] px-1.5 py-0.5 text-[10px] font-mono-spec text-[#7A7468] hover:text-[#1F1E1B] transition"
            >
              Odepnij
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="Usuń artefakt"
              className="rounded p-1 text-[#8E897E] hover:text-[#A94B3E] hover:bg-[#EFECE3] transition"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {artifact.content && (
        <div
          className={`text-xs leading-relaxed whitespace-pre-wrap ${
            artifact.type === 'message'
              ? 'rounded border border-[#DDD6C7] bg-[#F4F1EA] p-2.5 text-[#1F1E1B] select-all'
              : 'text-[#5C584F]'
          }`}
        >
          {artifact.content}
        </div>
      )}

      {artifact.url && (
        <div className="text-[10.5px] text-[#8E897E] truncate font-mono-spec">
          {artifact.url}
        </div>
      )}

      {taskTitle && onOpenTask && (
        <div className="pt-2 border-t border-[#EAE4D7] flex justify-end">
          <button
            type="button"
            onClick={onOpenTask}
            className="text-[11px] text-[#4A7C6A] hover:text-[#2E5446] transition truncate max-w-full font-medium"
          >
            {taskTitle} →
          </button>
        </div>
      )}
    </div>
  );
}
