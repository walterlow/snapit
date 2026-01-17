/**
 * VideoEditorPreview - Video preview container.
 * Wraps the GPUVideoPreview component with appropriate layout and error handling.
 */
import { GPUVideoPreview } from '../../components/VideoEditor/GPUVideoPreview';
import { GPUErrorBoundary } from '../../components/VideoEditor/GPUErrorBoundary';

export function VideoEditorPreview() {
  return (
    <div className="flex-1 min-h-0 p-4">
      <GPUErrorBoundary>
        <GPUVideoPreview />
      </GPUErrorBoundary>
    </div>
  );
}
