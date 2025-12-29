/**
 * Loading skeleton shown while editor components are being lazy-loaded.
 * Extracted from App.tsx for better separation of concerns.
 */
export const EditorLoadingSkeleton: React.FC = () => (
  <div className="flex-1 flex flex-col min-h-0">
    <div className="flex-1 flex min-h-0">
      {/* Canvas skeleton */}
      <div className="flex-1 overflow-hidden min-h-0 relative bg-[var(--polar-snow)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-[var(--text-muted)]">
          <div className="w-8 h-8 border-2 border-[var(--aurora-blue)] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading editor...</span>
        </div>
      </div>
      {/* Properties panel skeleton */}
      <div className="w-[280px] glass-panel border-l border-[var(--polar-frost)] p-4">
        <div className="space-y-4">
          <div className="h-6 bg-[var(--polar-frost)] rounded animate-pulse" />
          <div className="h-24 bg-[var(--polar-frost)] rounded animate-pulse" />
          <div className="h-8 bg-[var(--polar-frost)] rounded animate-pulse" />
        </div>
      </div>
    </div>
    {/* Toolbar skeleton */}
    <div className="h-16 glass-panel border-t border-[var(--polar-frost)] flex items-center justify-center gap-2 px-4">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="w-10 h-10 bg-[var(--polar-frost)] rounded-lg animate-pulse" />
      ))}
    </div>
  </div>
);
