import React from 'react';
import { Upload } from 'lucide-react';

export const DropZoneOverlay: React.FC = () => (
  <div className="absolute inset-0 z-50 bg-[var(--polar-snow)]/95 flex items-center justify-center pointer-events-none animate-fade-in">
    <div className="flex flex-col items-center gap-4 p-8 rounded-2xl border-2 border-dashed border-[var(--coral-400)] bg-[var(--coral-50)]">
      <div className="w-16 h-16 rounded-full bg-[var(--coral-100)] flex items-center justify-center">
        <Upload className="w-8 h-8 text-[var(--coral-500)]" />
      </div>
      <div className="text-center">
        <p className="text-lg font-semibold text-[var(--ink-black)]">Drop images here</p>
        <p className="text-sm text-[var(--ink-muted)]">Import images to your library</p>
      </div>
    </div>
  </div>
);
