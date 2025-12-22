import { useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

interface UseDragDropImportProps {
  onImportComplete: () => Promise<void>;
}

interface UseDragDropImportReturn {
  isDragOver: boolean;
  handleDragEnter: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => Promise<void>;
}

export function useDragDropImport({
  onImportComplete,
}: UseDragDropImportProps): UseDragDropImportReturn {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      dragCounter.current = 0;

      const files = Array.from(e.dataTransfer.files);
      const imageFiles = files.filter(
        (file) =>
          file.type.startsWith('image/') ||
          /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(file.name)
      );

      if (imageFiles.length === 0) {
        toast.error('No valid image files found');
        return;
      }

      const toastId = toast.loading(
        `Importing ${imageFiles.length} image${imageFiles.length > 1 ? 's' : ''}...`
      );

      try {
        let imported = 0;
        for (const file of imageFiles) {
          // Read file as base64
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onload = () => {
              const result = reader.result as string;
              // Remove data URL prefix to get just the base64 data
              const base64Data = result.split(',')[1];
              resolve(base64Data);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          // Save as new capture
          await invoke('save_capture', {
            request: {
              image_data: base64,
              capture_type: 'import',
              source: { region: null },
            },
          });
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

  return {
    isDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  };
}
