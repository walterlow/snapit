import React from 'react';

interface DateHeaderProps {
  label: string;
  count: number;
  isFirst?: boolean; // Kept for API compatibility but no longer affects styling
}

export const DateHeader: React.FC<DateHeaderProps> = ({ label, count }) => (
  <div className="flex items-center gap-4 pt-6 pb-4">
    <h3 className="text-sm font-semibold text-[var(--ink-dark)] whitespace-nowrap">
      {label}
    </h3>
    <div className="flex-1 h-px bg-[var(--polar-frost)]" />
    <span className="text-xs text-[var(--ink-subtle)] tabular-nums">
      {count} {count === 1 ? 'capture' : 'captures'}
    </span>
  </div>
);
