import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';

interface UseDragDropImportProps {
  onImportComplete: () => Promise<void>;
}

interface UseDragDropImportReturn {
  isDragOver: boolean;
}

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

const VALID_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

function isImageFile(path: string): boolean {
  const lower = path.toLowerCase();
  return VALID_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function useDragDropImport({
  onImportComplete,
}: UseDragDropImportProps): UseDragDropImportReturn {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDrop = useCallback(
    async (paths: string[]) => {
      const imageFiles = paths.filter(isImageFile);

      if (imageFiles.length === 0) {
        toast.error('No valid image files found');
        return;
      }

      const toastId = toast.loading(
        `Importing ${imageFiles.length} image${imageFiles.length > 1 ? 's' : ''}...`
      );

      try {
        let imported = 0;
        for (const filePath of imageFiles) {
          await invoke('import_image_from_path', { filePath });
          imported++;
        }

        await onImportComplete();
        toast.success(`Imported ${imported} image${imported > 1 ? 's' : ''}`, {
          id: toastId,
        });
      } catch (error) {
        console.error('Failed to import images:', error);
        toast.error('Failed to import images', { id: toastId });
      }
    },
    [onImportComplete]
  );

  useEffect(() => {
    // Listen for Tauri's native drag-drop events
    const unlistenDrop = listen<DragDropPayload>('tauri://drag-drop', (event) => {
      setIsDragOver(false);
      handleDrop(event.payload.paths);
    });

    const unlistenEnter = listen('tauri://drag-enter', () => {
      setIsDragOver(true);
    });

    const unlistenLeave = listen('tauri://drag-leave', () => {
      setIsDragOver(false);
    });

    return () => {
      unlistenDrop.then(fn => fn()).catch(() => {});
      unlistenEnter.then(fn => fn()).catch(() => {});
      unlistenLeave.then(fn => fn()).catch(() => {});
    };
  }, [handleDrop]);

  return {
    isDragOver,
  };
}
