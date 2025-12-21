import { useState, useEffect } from 'react';
import { Window } from '@tauri-apps/api/window';
import { Minus, Square, X, Maximize2, Aperture } from 'lucide-react';

interface TitlebarProps {
  title?: string;
  showLogo?: boolean;
}

export const Titlebar: React.FC<TitlebarProps> = ({
  title = 'SnapIt',
  showLogo = true
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const appWindow = Window.getCurrent();

  useEffect(() => {
    // Check initial maximized state
    appWindow.isMaximized().then(setIsMaximized);

    // Listen for window state changes
    const unlistenResize = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });

    return () => {
      unlistenResize.then((fn) => fn());
    };
  }, [appWindow]);

  // Handle drag state
  const handleMouseDown = () => setIsDragging(true);
  const handleMouseUp = () => setIsDragging(false);

  const handleMinimize = () => appWindow.minimize();
  const handleMaximize = () => appWindow.toggleMaximize();
  const handleClose = () => appWindow.close();

  return (
    <div
      data-tauri-drag-region
      className={`titlebar ${isDragging ? 'titlebar-dragging' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Left: Logo & Title */}
      <div className="titlebar-left" data-tauri-drag-region>
        {showLogo && (
          <div className="titlebar-logo">
            <Aperture className="w-3.5 h-3.5" />
          </div>
        )}
        <span className="titlebar-title" data-tauri-drag-region>
          {title}
        </span>
      </div>

      {/* Center: Drag Region */}
      <div className="titlebar-center" data-tauri-drag-region />

      {/* Right: Window Controls */}
      <div className="titlebar-controls">
        <button
          onClick={handleMinimize}
          className="titlebar-button titlebar-button-minimize"
          aria-label="Minimize"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleMaximize}
          className="titlebar-button titlebar-button-maximize"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <Maximize2 className="w-3 h-3" />
          ) : (
            <Square className="w-3 h-3" />
          )}
        </button>
        <button
          onClick={handleClose}
          className="titlebar-button titlebar-button-close"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
