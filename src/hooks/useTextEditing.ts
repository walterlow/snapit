import { useState, useCallback, useRef } from 'react';
import type { CanvasShape } from '../types';

interface UseTextEditingProps {
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
  zoom: number;
  position: { x: number; y: number };
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface TextareaPosition {
  left: number;
  top: number;
  fontSize: number;
  color: string;
}

interface UseTextEditingReturn {
  editingTextId: string | null;
  editingTextValue: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  startEditing: (shapeId: string, currentText: string) => void;
  handleTextChange: (value: string) => void;
  handleSaveTextEdit: () => void;
  handleCancelTextEdit: () => void;
  getTextareaPosition: () => TextareaPosition | null;
}

/**
 * Hook for inline text editing in the editor canvas
 * Manages the state and handlers for editing text shapes
 */
export const useTextEditing = ({
  shapes,
  onShapesChange,
  zoom,
  position,
  containerRef,
}: UseTextEditingProps): UseTextEditingReturn => {
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingTextValue, setEditingTextValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Start editing a text shape
  const startEditing = useCallback((shapeId: string, currentText: string) => {
    setEditingTextId(shapeId);
    setEditingTextValue(currentText);
  }, []);

  // Handle text value change
  const handleTextChange = useCallback((value: string) => {
    setEditingTextValue(value);
  }, []);

  // Save text edit
  const handleSaveTextEdit = useCallback(() => {
    if (!editingTextId) return;

    const updatedShapes = shapes.map(s =>
      s.id === editingTextId ? { ...s, text: editingTextValue } : s
    );
    onShapesChange(updatedShapes);
    setEditingTextId(null);
    setEditingTextValue('');
  }, [editingTextId, editingTextValue, shapes, onShapesChange]);

  // Cancel text edit
  const handleCancelTextEdit = useCallback(() => {
    setEditingTextId(null);
    setEditingTextValue('');
  }, []);

  // Get the position for the textarea overlay
  const getTextareaPosition = useCallback((): TextareaPosition | null => {
    if (!editingTextId || !containerRef.current) return null;

    const shape = shapes.find(s => s.id === editingTextId);
    if (!shape) return null;

    // Get container bounds
    const containerRect = containerRef.current.getBoundingClientRect();

    // Calculate screen position
    const screenX = containerRect.left + position.x + (shape.x || 0) * zoom;
    const screenY = containerRect.top + position.y + (shape.y || 0) * zoom;

    return {
      left: screenX,
      top: screenY,
      fontSize: (shape.fontSize || 16) * zoom,
      color: shape.fill || '#000',
    };
  }, [editingTextId, shapes, position, zoom, containerRef]);

  return {
    editingTextId,
    editingTextValue,
    textareaRef,
    startEditing,
    handleTextChange,
    handleSaveTextEdit,
    handleCancelTextEdit,
    getTextareaPosition,
  };
};
