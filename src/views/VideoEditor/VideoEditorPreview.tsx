/**
 * VideoEditorPreview - Video preview container.
 * Wraps the GPUVideoPreview component with appropriate layout.
 */
import { GPUVideoPreview } from '../../components/VideoEditor/GPUVideoPreview';

export function VideoEditorPreview() {
  return (
    <div className="flex-1 min-h-0 p-4">
      <GPUVideoPreview />
    </div>
  );
}
