import React, { useMemo } from 'react';
import { RegionSelector } from '../components/RegionSelector/RegionSelector';

/**
 * Entry component for overlay windows.
 * Parses URL parameters to get monitor info and renders the RegionSelector.
 */
export const OverlayWindow: React.FC = () => {
  const params = useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return {
      monitor: parseInt(urlParams.get('monitor') || '0', 10),
      x: parseInt(urlParams.get('x') || '0', 10),
      y: parseInt(urlParams.get('y') || '0', 10),
      width: parseInt(urlParams.get('width') || '1920', 10),
      height: parseInt(urlParams.get('height') || '1080', 10),
      scale: parseFloat(urlParams.get('scale') || '1'),
    };
  }, []);

  return (
    <div className="w-screen h-screen overflow-hidden">
      <RegionSelector
        monitorIndex={params.monitor}
        monitorX={params.x}
        monitorY={params.y}
        monitorWidth={params.width}
        monitorHeight={params.height}
        scaleFactor={params.scale}
      />
    </div>
  );
};

export default OverlayWindow;
