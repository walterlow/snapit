import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModeSelector } from './ModeSelector';
import type { CaptureType } from '../../types';

describe('ModeSelector', () => {
  const defaultProps = {
    activeMode: 'video' as CaptureType,
    onModeChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render all three mode buttons', () => {
      render(<ModeSelector {...defaultProps} />);

      expect(screen.getByTitle('Video')).toBeInTheDocument();
      expect(screen.getByTitle('GIF')).toBeInTheDocument();
      expect(screen.getByTitle('Photo')).toBeInTheDocument();
    });

    it('should display mode labels', () => {
      render(<ModeSelector {...defaultProps} />);

      expect(screen.getByText('Video')).toBeInTheDocument();
      expect(screen.getByText('GIF')).toBeInTheDocument();
      expect(screen.getByText('Photo')).toBeInTheDocument();
    });

    it('should mark the active mode button', () => {
      render(<ModeSelector {...defaultProps} activeMode="gif" />);

      const gifButton = screen.getByTitle('GIF');
      expect(gifButton.className).toContain('glass-mode-btn--active');

      const videoButton = screen.getByTitle('Video');
      expect(videoButton.className).not.toContain('glass-mode-btn--active');
    });
  });

  describe('interactions', () => {
    it('should call onModeChange when clicking a mode button', () => {
      const onModeChange = vi.fn();
      render(<ModeSelector {...defaultProps} onModeChange={onModeChange} />);

      fireEvent.click(screen.getByTitle('GIF'));

      expect(onModeChange).toHaveBeenCalledTimes(1);
      expect(onModeChange).toHaveBeenCalledWith('gif');
    });

    it('should call onModeChange with correct mode for each button', () => {
      const onModeChange = vi.fn();
      render(<ModeSelector {...defaultProps} onModeChange={onModeChange} />);

      fireEvent.click(screen.getByTitle('Video'));
      expect(onModeChange).toHaveBeenLastCalledWith('video');

      fireEvent.click(screen.getByTitle('GIF'));
      expect(onModeChange).toHaveBeenLastCalledWith('gif');

      fireEvent.click(screen.getByTitle('Photo'));
      expect(onModeChange).toHaveBeenLastCalledWith('screenshot');
    });
  });

  describe('disabled state', () => {
    it('should disable all buttons when disabled prop is true', () => {
      render(<ModeSelector {...defaultProps} disabled={true} />);

      expect(screen.getByTitle('Video')).toBeDisabled();
      expect(screen.getByTitle('GIF')).toBeDisabled();
      expect(screen.getByTitle('Photo')).toBeDisabled();
    });

    it('should add opacity class when disabled', () => {
      const { container } = render(<ModeSelector {...defaultProps} disabled={true} />);

      const group = container.querySelector('.glass-mode-group');
      expect(group?.className).toContain('opacity-50');
    });

    it('should not call onModeChange when disabled', () => {
      const onModeChange = vi.fn();
      render(<ModeSelector {...defaultProps} onModeChange={onModeChange} disabled={true} />);

      fireEvent.click(screen.getByTitle('GIF'));

      expect(onModeChange).not.toHaveBeenCalled();
    });
  });

  describe('fullWidth mode', () => {
    it('should add full width class when fullWidth prop is true', () => {
      const { container } = render(<ModeSelector {...defaultProps} fullWidth={true} />);

      const group = container.querySelector('.glass-mode-group');
      expect(group?.className).toContain('glass-mode-group--full');
    });

    it('should not have full width class by default', () => {
      const { container } = render(<ModeSelector {...defaultProps} />);

      const group = container.querySelector('.glass-mode-group');
      expect(group?.className).not.toContain('glass-mode-group--full');
    });
  });
});
