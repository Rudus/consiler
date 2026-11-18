import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import { api } from '../api';
import { NotebookMark } from './NotebookMark';

interface LoginViewProps {
  onSuccess: () => void;
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Błąd logowania');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-dot-grid flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-[#DDD6C7] bg-[#FAF8F3] shadow-[0_12px_36px_rgba(31,30,27,0.08)] relative overflow-hidden">
        {/* Left binding strip inspired by MD Notebook */}
        <div className="absolute inset-y-0 left-0 w-2 spine-binding-strip border-r border-[#EAE4D7]" />

        <div className="p-8 pl-10">
          <div className="flex flex-col items-center text-center mb-7">
            <div className="h-10 w-10 rounded-full border border-[#DDD6C7] bg-[#FDFCF9] flex items-center justify-center text-[#1F1E1B] mb-4">
              <NotebookMark className="h-5 w-5" />
            </div>
            <span className="font-mono-spec text-[9.5px] tracking-[0.2em] uppercase text-[#8E897E] mb-1">
              Osobisty Dziennik Zadań
            </span>
            <h1 className="font-serif-editorial text-3xl font-normal text-[#1F1E1B]">
              Consiler
            </h1>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block font-mono-spec text-[10px] tracking-[0.14em] uppercase text-[#7A7468] mb-1.5">
                Hasło dostępu
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-3.5 w-3.5 text-[#8E897E]" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Wpisz hasło..."
                  autoFocus
                  className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] pl-9 pr-3 py-2 text-sm text-[#1F1E1B] placeholder:text-[#9A9488] focus:border-[#4A7C6A] focus:outline-none"
                />
              </div>
            </div>

            {error && (
              <p className="text-xs text-[#A94B3E] bg-[#F7EAE8] border border-[#E5C9C4] rounded px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full rounded bg-[#1F1E1B] hover:bg-[#33312C] disabled:opacity-45 py-2.5 text-xs font-medium tracking-wide text-[#FAF8F3] transition"
            >
              {loading ? 'Otwieranie…' : 'Otwórz dziennik'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
