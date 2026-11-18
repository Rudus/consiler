import React, { useEffect, useState } from 'react';
import { Loader2, Lock, ShieldCheck, X } from 'lucide-react';
import { api } from '../api';
import type { CheckoutProfile } from '../types';

interface ShippingProfileModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (configured: boolean) => void;
}

const EMPTY_PROFILE: CheckoutProfile = {
  fullName: '',
  email: '',
  phone: '',
  street: '',
  postalCode: '',
  city: '',
  preferredLocker: '',
  notes: '',
};

export function ShippingProfileModal({
  open,
  onClose,
  onSaved,
}: ShippingProfileModalProps) {
  const [form, setForm] = useState<CheckoutProfile>(EMPTY_PROFILE);
  const [maxAmountPln, setMaxAmountPln] = useState(500);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setLoading(true);
    void api
      .getCheckoutProfile(true)
      .then((res) => {
        setMaxAmountPln(res.maxAmountPln);
        setForm(res.profile ?? EMPTY_PROFILE);
      })
      .catch(() => setError('Nie udało się wczytać profilu dostawy.'))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.saveCheckoutProfile(form);
      onSaved(res.configured);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Błąd zapisu profilu.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1F1E1B]/45 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-[#DDD6C7] bg-[#FAF8F3] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#DDD6C7] bg-[#F4F1EA]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[#4A7C6A]" />
            <h2 className="font-serif-editorial text-lg text-[#1F1E1B]">
              Dane dostawy (Assisted Checkout)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[#7A7468] hover:bg-[#EAE4D7] hover:text-[#1F1E1B]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-3.5">
          <div className="rounded border border-[#C6D1BC] bg-[#E3EBDC] px-3 py-2 text-[11px] text-[#1F261D] flex items-start gap-2">
            <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[#4A7C6A]" />
            <span>
              Dane są szyfrowane lokalnie (AES-256-GCM) i nigdy nie trafiają w promptach do AI. Agent wypełnia formularz dostawy i zatrzymuje się przed płatnością (limit alertu: <strong>{maxAmountPln} zł</strong>).
            </span>
          </div>

          {loading ? (
            <div className="py-10 flex justify-center text-[#7A7468]">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                    Imię i nazwisko *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.fullName}
                    onChange={(e) =>
                      setForm({ ...form, fullName: e.target.value })
                    }
                    placeholder="Jan Kowalski"
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                    E-mail *
                  </label>
                  <input
                    type="email"
                    required
                    value={form.email}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                    placeholder="jan@example.com"
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                    Telefon *
                  </label>
                  <input
                    type="tel"
                    required
                    value={form.phone}
                    onChange={(e) =>
                      setForm({ ...form, phone: e.target.value })
                    }
                    placeholder="+48 600 000 000"
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                    Ulica i numer
                  </label>
                  <input
                    type="text"
                    value={form.street}
                    onChange={(e) =>
                      setForm({ ...form, street: e.target.value })
                    }
                    placeholder="ul. Przykładowa 12/4"
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                    Kod pocztowy
                  </label>
                  <input
                    type="text"
                    value={form.postalCode}
                    onChange={(e) =>
                      setForm({ ...form, postalCode: e.target.value })
                    }
                    placeholder="00-001"
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                    Miasto
                  </label>
                  <input
                    type="text"
                    value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    placeholder="Warszawa"
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                    Preferowany Paczkomat
                  </label>
                  <input
                    type="text"
                    value={form.preferredLocker}
                    onChange={(e) =>
                      setForm({ ...form, preferredLocker: e.target.value })
                    }
                    placeholder="np. WAW123M"
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-mono-spec text-[10px] tracking-[0.1em] uppercase text-[#7A7468] mb-1">
                    Uwagi do dostawy
                  </label>
                  <input
                    type="text"
                    value={form.notes}
                    onChange={(e) =>
                      setForm({ ...form, notes: e.target.value })
                    }
                    placeholder="np. kod do domofonu"
                    className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] px-3 py-1.5 text-xs text-[#1F1E1B] focus:border-[#4A7C6A] focus:outline-none"
                  />
                </div>
              </div>

              {error && (
                <p className="text-xs text-[#A94B3E] bg-[#F7E9E7] border border-[#E2C2BD] rounded px-3 py-2">
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded px-3.5 py-1.5 text-xs text-[#7A7468] hover:text-[#1F1E1B]"
                >
                  Anuluj
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#1F1E1B] hover:bg-[#34322D] disabled:opacity-50 px-4 py-1.5 text-xs font-medium text-[#FAF8F3] transition"
                >
                  {saving ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Szyfruję i zapisuję…</span>
                    </>
                  ) : (
                    <span>Zapisz dane dostawy</span>
                  )}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
