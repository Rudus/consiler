import { useState } from 'react';
import {
  Check,
  ExternalLink,
  Loader2,
  Monitor,
  ShoppingCart,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { CheckoutSession, CheckoutSessionStatus } from '../types';

export const CHECKOUT_STATUS_LABEL: Record<CheckoutSessionStatus, string> = {
  PREPARING: 'PRZYGOTOWYWANIE…',
  READY_FOR_HANDOFF: 'GOTOWE DO PŁATNOŚCI',
  HANDOFF_MANUAL: 'DO DOKOŃCZENIA',
  LAUNCHED_LOCAL: 'OTWARTO NA PC',
  COMPLETED: 'ZAMÓWIONE',
  CANCELLED: 'ANULOWANO',
  FAILED: 'BŁĄD',
};

export function isActiveCheckoutSession(cs: CheckoutSession): boolean {
  return (
    cs.status === 'PREPARING' ||
    cs.status === 'READY_FOR_HANDOFF' ||
    cs.status === 'HANDOFF_MANUAL' ||
    cs.status === 'LAUNCHED_LOCAL'
  );
}

interface CheckoutSessionCardProps {
  session: CheckoutSession;
  onZoomImage?: (src: string) => void;
}

export function CheckoutSessionCard({
  session,
  onZoomImage,
}: CheckoutSessionCardProps) {
  const [launching, setLaunching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isPreparing = session.status === 'PREPARING';
  const isClosed =
    session.status === 'COMPLETED' ||
    session.status === 'CANCELLED' ||
    session.status === 'FAILED';

  const statusToneCls =
    session.status === 'READY_FOR_HANDOFF' || session.status === 'LAUNCHED_LOCAL'
      ? 'bg-[#E3EBDC] text-[#244337] border-[#C6D1BC]'
      : session.status === 'HANDOFF_MANUAL'
        ? 'bg-[#EFE6D2] text-[#7B5218] border-[#D6C9AD]'
        : session.status === 'FAILED' || session.status === 'CANCELLED'
          ? 'bg-[#F7E9E7] text-[#A94B3E] border-[#E2C2BD]'
          : 'bg-[#E8EFF3] text-[#36566B] border-[#C5D4DE]';

  const trimmedVariant =
    session.variantNote && session.variantNote.length > 160
      ? `${session.variantNote.slice(0, 157)}…`
      : session.variantNote;

  return (
    <div className="rounded-lg border border-[#C6D1BC] bg-[#F4F7F1] p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isPreparing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4A7C6A] shrink-0" />
          ) : (
            <ShoppingCart className="h-3.5 w-3.5 text-[#4A7C6A] shrink-0" />
          )}
          <span className="text-xs font-semibold text-[#1F1E1B] truncate">
            {session.shopDomain}
          </span>
          <span
            className={`font-mono-spec text-[9.5px] px-1.5 py-0.5 rounded border uppercase ${statusToneCls}`}
          >
            {CHECKOUT_STATUS_LABEL[session.status] ?? session.status}
          </span>
        </div>
        {session.detectedTotal && (
          <span className="font-mono-spec text-xs font-semibold text-[#244337]">
            Razem: {session.detectedTotal}
          </span>
        )}
      </div>

      {(trimmedVariant || session.detectedShipping || session.message) && (
        <div className="text-xs text-[#36332D] space-y-1">
          {trimmedVariant && (
            <div>
              <span className="text-[#7A7468]">Wariant:</span> {trimmedVariant}
            </div>
          )}
          {session.detectedShipping && (
            <div>
              <span className="text-[#7A7468]">Dostawa:</span>{' '}
              {session.detectedShipping}
            </div>
          )}
          {session.message && (
            <p className="text-[#5C584F] leading-relaxed">{session.message}</p>
          )}
        </div>
      )}

      {session.screenshotFilename && (
        <button
          type="button"
          onClick={() =>
            onZoomImage?.(`/api/uploads/${session.screenshotFilename}`)
          }
          className="group relative block w-full overflow-hidden rounded border border-[#DDD6C7] bg-[#FAF8F3]"
        >
          <img
            src={`/api/uploads/${session.screenshotFilename}`}
            alt="Podgląd koszyka"
            className="w-full max-h-48 object-cover object-top"
          />
          {onZoomImage && (
            <span className="absolute bottom-1.5 right-1.5 font-mono-spec text-[10px] px-1.5 py-0.5 rounded bg-[#1F1E1B]/80 text-[#FAF8F3] opacity-0 group-hover:opacity-100 transition">
              Powiększ screen koszyka
            </span>
          )}
        </button>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {!isClosed && session.storageStatePath && (
          <button
            type="button"
            disabled={launching}
            onClick={async () => {
              setLaunching(true);
              setNotice(null);
              try {
                await api.launchCheckoutLocal(session.id);
                setNotice(
                  'Otwarto osobne okno Chromium (Chrome for Testing) na PC z Twoim koszykiem. Jeśli nie wyskoczyło nad Operą, sprawdź ikonę na pasku zadań Windows.'
                );
              } catch (err) {
                setNotice(
                  `Błąd uruchamiania okna: ${err instanceof Error ? err.message : 'nieznany błąd'}`
                );
              } finally {
                setLaunching(false);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded bg-[#1F1E1B] hover:bg-[#33312C] disabled:opacity-50 px-2.5 py-1.5 text-[11px] font-medium text-[#FAF8F3] transition"
          >
            {launching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Monitor className="h-3.5 w-3.5" />
            )}
            <span>
              {launching ? 'Otwieram Chromium…' : 'Otwórz sesję na PC'}
            </span>
          </button>
        )}
        {session.checkoutUrl && (
          <a
            href={session.checkoutUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-[#C5D4DE] bg-[#E8EFF3] hover:bg-[#DCE7EE] px-2.5 py-1.5 text-[11px] font-medium text-[#36566B] transition"
          >
            <ExternalLink className="h-3 w-3" />
            <span>Otwórz stronę</span>
          </a>
        )}
        {!isClosed && (
          <>
            <button
              type="button"
              onClick={() => void api.completeCheckout(session.id)}
              className="inline-flex items-center gap-1 rounded border border-[#C6D1BC] bg-[#E3EBDC] hover:bg-[#D5E2C8] px-2.5 py-1.5 text-[11px] font-medium text-[#244337] transition"
            >
              <Check className="h-3 w-3" />
              <span>Zamówione</span>
            </button>
            <button
              type="button"
              onClick={() => void api.cancelCheckout(session.id)}
              className="inline-flex items-center gap-1 rounded border border-[#E2C2BD] bg-[#F7E9E7] hover:bg-[#EED9D5] px-2.5 py-1.5 text-[11px] text-[#A94B3E] transition"
            >
              <X className="h-3 w-3" />
              <span>Anuluj</span>
            </button>
          </>
        )}
      </div>

      {notice && (
        <p className="text-[11px] text-[#36566B] bg-[#E8EFF3] border border-[#C5D4DE] rounded px-2.5 py-1.5">
          {notice}
        </p>
      )}
    </div>
  );
}
