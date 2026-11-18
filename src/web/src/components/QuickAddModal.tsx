import React, { useEffect, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { api } from '../api';
import { NotebookMark } from './NotebookMark';

interface QuickAddModalProps {
  open: boolean;
  initialFiles: File[];
  onClose: () => void;
  onCreated: (taskId: string) => void;
}

export function QuickAddModal({
  open,
  initialFiles,
  onClose,
  onCreated,
}: QuickAddModalProps) {
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setFiles(initialFiles);
      setError('');
    } else {
      setPrompt('');
      setFiles([]);
    }
  }, [open, initialFiles]);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [files]);

  if (!open) return null;

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith('image/')
    );
    if (pasted.length > 0) {
      setFiles((prev) => [...prev, ...pasted]);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files);
      setFiles((prev) => [...prev, ...selected]);
    }
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() && files.length === 0) {
      setError('Dodaj opis zadania lub wklej zrzut ekranu.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const { task } = await api.createTask(prompt.trim(), files);
      onCreated(task.id);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Nie udało się dodać zadania.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1F1E1B]/35 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-[#DDD6C7] bg-[#FAF8F3] shadow-[0_20px_50px_rgba(31,30,27,0.16)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onPaste={handlePaste}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#DDD6C7] bg-[#FDFCF9]">
          <div className="flex items-center gap-2.5">
            <NotebookMark className="h-4 w-4 text-[#4A7C6A]" />
            <div>
              <span className="block font-mono-spec text-[9.5px] tracking-[0.14em] uppercase text-[#8E897E]">
                Nowy wpis
              </span>
              <h2 className="font-serif-editorial text-lg font-normal text-[#1F1E1B] leading-tight">
                Dodaj zadanie dla asystenta
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[#7A7468] hover:bg-[#EFECE3] hover:text-[#1F1E1B] transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Np. „sprawdź czy warto kupić i przypomnij jutro o 18:00” albo po prostu wklej zrzut ekranu (Ctrl+V)..."
              rows={3}
              autoFocus
              className="w-full rounded border border-[#DDD6C7] bg-[#FDFCF9] p-3 text-sm text-[#1F1E1B] placeholder:text-[#9A9488] focus:border-[#4A7C6A] focus:outline-none resize-none"
            />
          </div>

          {previews.length > 0 && (
            <div className="grid grid-cols-2 gap-2.5">
              {previews.map((url, idx) => (
                <div
                  key={url}
                  className="relative group rounded overflow-hidden border border-[#DDD6C7] bg-[#EFECE3] aspect-video"
                >
                  <img
                    src={url}
                    alt="Zrzut ekranu"
                    className="w-full h-full object-contain"
                  />
                  <button
                    type="button"
                    onClick={() => removeFile(idx)}
                    className="absolute top-1.5 right-1.5 rounded-full bg-[#1F1E1B]/75 p-1 text-[#FAF8F3] opacity-0 group-hover:opacity-100 transition"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label className="inline-flex items-center gap-2 rounded border border-dashed border-[#C7BFAE] hover:border-[#4A7C6A] bg-[#F4F1EA]/70 px-3 py-2 text-xs text-[#5C584F] hover:text-[#1F1E1B] cursor-pointer transition">
              <ImagePlus className="h-4 w-4 text-[#4A7C6A]" />
              <span>Dodaj / wklej screen (Ctrl+V)</span>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileInput}
                className="hidden"
              />
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded bg-[#1F1E1B] hover:bg-[#33312C] disabled:opacity-45 px-4 py-2 text-xs font-medium text-[#FAF8F3] transition"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Analizuję…</span>
                </>
              ) : (
                <span>Zapisz i analizuj</span>
              )}
            </button>
          </div>

          {error && (
            <p className="text-xs text-[#A94B3E] bg-[#F7EAE8] border border-[#E5C9C4] rounded px-3 py-2">
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
