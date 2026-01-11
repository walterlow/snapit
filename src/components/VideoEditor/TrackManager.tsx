import { memo } from 'react';
import { Film, Type, Square, Search, Video, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useVideoEditorStore } from '../../stores/videoEditorStore';

type TrackType = 'video' | 'text' | 'mask' | 'zoom' | 'scene';

interface TrackDefinition {
  type: TrackType;
  label: string;
  icon: React.ReactNode;
  locked?: boolean;
}

const trackDefinitions: TrackDefinition[] = [
  {
    type: 'video',
    label: 'Clip',
    icon: <Film className="w-4 h-4" />,
    locked: true, // Video track is always visible
  },
  {
    type: 'text',
    label: 'Text',
    icon: <Type className="w-4 h-4" />,
  },
  {
    type: 'mask',
    label: 'Mask',
    icon: <Square className="w-4 h-4" />,
  },
  {
    type: 'zoom',
    label: 'Zoom',
    icon: <Search className="w-4 h-4" />,
    locked: true, // Zoom track is always visible
  },
  {
    type: 'scene',
    label: 'Scene',
    icon: <Video className="w-4 h-4" />,
  },
];

const selectTrackVisibility = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.trackVisibility;
const selectHasWebcam = (s: ReturnType<typeof useVideoEditorStore.getState>) => !!s.project?.sources.webcamVideo;

/**
 * TrackManager - Dropdown menu to toggle track visibility
 */
export const TrackManager = memo(function TrackManager() {
  const trackVisibility = useVideoEditorStore(selectTrackVisibility);
  const hasWebcam = useVideoEditorStore(selectHasWebcam);
  const { toggleTrackVisibility } = useVideoEditorStore();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              className="glass-btn h-8 w-8"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Plus className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Toggle Tracks</p>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" sideOffset={4}>
        <DropdownMenuLabel className="text-xs text-[var(--ink-muted)]">
          Visible Tracks
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {trackDefinitions.map((track) => {
          // Scene track only available if webcam exists
          if (track.type === 'scene' && !hasWebcam) {
            return null;
          }

          return (
            <DropdownMenuCheckboxItem
              key={track.type}
              checked={trackVisibility[track.type]}
              disabled={track.locked}
              onCheckedChange={() => {
                if (!track.locked) {
                  toggleTrackVisibility(track.type);
                }
              }}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="flex items-center gap-2">
                {track.icon}
                <span>{track.label}</span>
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
