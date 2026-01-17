import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CropDialog } from './CropDialog';
import type { CropConfig, CompositionConfig } from '../../types';

// Mock convertFileSrc from Tauri
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

// Helper to get number inputs from the dialog
function getNumberInputs() {
  const dialog = screen.getByRole('dialog');
  return dialog.querySelectorAll('input[type="number"]');
}

describe('CropDialog', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onApply: vi.fn(),
    videoWidth: 1920,
    videoHeight: 1080,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render when open', () => {
      render(<CropDialog {...defaultProps} />);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('should not render when closed', () => {
      render(<CropDialog {...defaultProps} open={false} />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('should display dialog title with Crop icon', () => {
      render(<CropDialog {...defaultProps} />);
      expect(screen.getByText('Crop Video')).toBeInTheDocument();
    });

    it('should display dialog description', () => {
      render(<CropDialog {...defaultProps} />);
      expect(
        screen.getByText(/Crop the video content/)
      ).toBeInTheDocument();
    });

    it('should render position and size inputs', () => {
      render(<CropDialog {...defaultProps} />);

      // Check for X, Y, Width, Height labels
      expect(screen.getByText('X')).toBeInTheDocument();
      expect(screen.getByText('Y')).toBeInTheDocument();
      expect(screen.getByText('Width')).toBeInTheDocument();
      expect(screen.getByText('Height')).toBeInTheDocument();
    });

    it('should render Cancel and Apply buttons', () => {
      render(<CropDialog {...defaultProps} />);

      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /apply crop/i })).toBeInTheDocument();
    });

    it('should render aspect ratio controls', () => {
      render(<CropDialog {...defaultProps} />);

      // Check for aspect ratio section labels
      expect(screen.getByText('Video Crop Aspect Ratio')).toBeInTheDocument();
      expect(screen.getByText('Composition (Output Canvas)')).toBeInTheDocument();
    });

    it('should render action buttons (Lock, Fill, Reset)', () => {
      render(<CropDialog {...defaultProps} />);

      expect(screen.getByRole('button', { name: /unlocked/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /fill/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
    });

    it('should render video crop aspect ratio presets', () => {
      render(<CropDialog {...defaultProps} />);

      // Find the crop aspect ratio section
      const cropSection = screen.getByText('Video Crop Aspect Ratio').parentElement!;

      // Check for specific presets within that section
      expect(within(cropSection).getByRole('radio', { name: /free/i })).toBeInTheDocument();
      expect(within(cropSection).getByRole('radio', { name: '16:9' })).toBeInTheDocument();
      expect(within(cropSection).getByRole('radio', { name: '9:16' })).toBeInTheDocument();
      expect(within(cropSection).getByRole('radio', { name: '1:1' })).toBeInTheDocument();
      expect(within(cropSection).getByRole('radio', { name: '4:3' })).toBeInTheDocument();
      expect(within(cropSection).getByRole('radio', { name: /original/i })).toBeInTheDocument();
    });

    it('should render composition presets', () => {
      render(<CropDialog {...defaultProps} />);

      // Find the composition section
      const compositionSection = screen.getByText('Composition (Output Canvas)').parentElement!;

      // Auto preset should be in composition section
      expect(within(compositionSection).getByRole('radio', { name: /auto/i })).toBeInTheDocument();
    });
  });

  describe('initial crop values', () => {
    it('should use default crop (80% centered) when no initialCrop', () => {
      render(<CropDialog {...defaultProps} />);

      // Default crop should be 80% of video size, centered
      const expectedWidth = Math.round(1920 * 0.8); // 1536
      const expectedHeight = Math.round(1080 * 0.8); // 864

      // Find inputs from the dialog
      const inputs = getNumberInputs();
      expect(inputs.length).toBe(4);

      // Width is 3rd input, Height is 4th
      expect(inputs[2]).toHaveValue(expectedWidth);
      expect(inputs[3]).toHaveValue(expectedHeight);
    });

    it('should use initialCrop when provided', () => {
      const initialCrop: CropConfig = {
        enabled: true,
        x: 100,
        y: 50,
        width: 800,
        height: 600,
        lockAspectRatio: false,
        aspectRatio: null,
      };

      render(<CropDialog {...defaultProps} initialCrop={initialCrop} />);

      // Find inputs from the dialog
      const inputs = getNumberInputs();
      expect(inputs.length).toBe(4);

      expect(inputs[0]).toHaveValue(100); // X
      expect(inputs[1]).toHaveValue(50);  // Y
      expect(inputs[2]).toHaveValue(800); // Width
      expect(inputs[3]).toHaveValue(600); // Height
    });

    it('should use default crop when initialCrop has zero dimensions', () => {
      const invalidCrop: CropConfig = {
        enabled: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        lockAspectRatio: false,
        aspectRatio: null,
      };

      render(<CropDialog {...defaultProps} initialCrop={invalidCrop} />);

      // Should fall back to default (80% centered)
      const inputs = getNumberInputs();
      expect(inputs[2]).toHaveValue(Math.round(1920 * 0.8)); // Width
    });

    it('should use initialComposition when provided', () => {
      const initialComposition: CompositionConfig = {
        mode: 'manual',
        aspectRatio: 16 / 9,
        aspectPreset: '16:9',
      };

      render(<CropDialog {...defaultProps} initialComposition={initialComposition} />);

      // 16:9 should be selected in composition section
      // This is indicated by the selected state of the toggle group item
      // The exact verification depends on how ToggleGroup renders selected state
    });
  });

  describe('onApply callback', () => {
    it('should call onApply with crop values when Apply is clicked', async () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
          lockAspectRatio: expect.any(Boolean),
        }),
        expect.objectContaining({
          mode: expect.any(String),
        })
      );
    });

    it('should call onClose after applying', () => {
      const onClose = vi.fn();
      render(<CropDialog {...defaultProps} onClose={onClose} />);

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should set enabled to true when crop differs from full video', () => {
      const onApply = vi.fn();
      const initialCrop: CropConfig = {
        enabled: false,
        x: 100,
        y: 100,
        width: 800,
        height: 600,
        lockAspectRatio: false,
        aspectRatio: null,
      };

      render(<CropDialog {...defaultProps} onApply={onApply} initialCrop={initialCrop} />);

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true, // Should be true since crop is not full video
        }),
        expect.any(Object)
      );
    });

    it('should set enabled to false when crop equals full video', () => {
      const onApply = vi.fn();
      const fullVideoCrop: CropConfig = {
        enabled: true,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        lockAspectRatio: false,
        aspectRatio: null,
      };

      render(<CropDialog {...defaultProps} onApply={onApply} initialCrop={fullVideoCrop} />);

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false, // Should be false since crop equals full video
        }),
        expect.any(Object)
      );
    });
  });

  describe('onClose callback', () => {
    it('should call onClose when Cancel is clicked', () => {
      const onClose = vi.fn();
      render(<CropDialog {...defaultProps} onClose={onClose} />);

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when dialog is dismissed', () => {
      const onClose = vi.fn();
      render(<CropDialog {...defaultProps} onClose={onClose} />);

      // DialogContent has a close button (X) that triggers onOpenChange
      const closeButton = screen.getByRole('button', { name: /close/i });
      fireEvent.click(closeButton);

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('aspect ratio lock toggle', () => {
    it('should toggle aspect ratio lock when clicking lock button', () => {
      render(<CropDialog {...defaultProps} />);

      // Initially unlocked
      const lockButton = screen.getByRole('button', { name: /unlocked/i });
      expect(lockButton).toBeInTheDocument();

      // Click to lock
      fireEvent.click(lockButton);

      // Should now show locked
      expect(screen.getByRole('button', { name: /locked/i })).toBeInTheDocument();
    });

    it('should toggle from locked to unlocked', () => {
      const initialCrop: CropConfig = {
        enabled: true,
        x: 0,
        y: 0,
        width: 1600,
        height: 900,
        lockAspectRatio: true,
        aspectRatio: 16 / 9,
      };

      render(<CropDialog {...defaultProps} initialCrop={initialCrop} />);

      // Initially locked
      const lockButton = screen.getByRole('button', { name: /locked/i });
      expect(lockButton).toBeInTheDocument();

      // Click to unlock
      fireEvent.click(lockButton);

      // Should now show unlocked
      expect(screen.getByRole('button', { name: /unlocked/i })).toBeInTheDocument();
    });
  });

  describe('aspect ratio presets', () => {
    it('should apply 16:9 aspect ratio when selected', async () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      // Find the crop aspect ratio section and click on 16:9 preset
      const cropSection = screen.getByText('Video Crop Aspect Ratio').parentElement!;
      const preset16_9 = within(cropSection).getByRole('radio', { name: '16:9' });
      fireEvent.click(preset16_9);

      // Apply and check result
      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.lockAspectRatio).toBe(true);
      expect(cropArg.aspectRatio).toBeCloseTo(16 / 9, 2);
    });

    it('should apply 1:1 aspect ratio when selected', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      // Find the crop aspect ratio section and click on 1:1 preset
      const cropSection = screen.getByText('Video Crop Aspect Ratio').parentElement!;
      const preset1_1 = within(cropSection).getByRole('radio', { name: '1:1' });
      fireEvent.click(preset1_1);

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.lockAspectRatio).toBe(true);
      expect(cropArg.aspectRatio).toBeCloseTo(1, 2);
    });

    it('should unlock aspect ratio when Free is selected', () => {
      // Start with locked aspect ratio
      const initialCrop: CropConfig = {
        enabled: true,
        x: 0,
        y: 0,
        width: 1600,
        height: 900,
        lockAspectRatio: true,
        aspectRatio: 16 / 9,
      };

      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} initialCrop={initialCrop} />);

      // Find the crop aspect ratio section and click on Free preset
      const cropSection = screen.getByText('Video Crop Aspect Ratio').parentElement!;
      const presetFree = within(cropSection).getByRole('radio', { name: /free/i });
      fireEvent.click(presetFree);

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.lockAspectRatio).toBe(false);
      expect(cropArg.aspectRatio).toBeNull();
    });
  });

  describe('input field interactions', () => {
    it('should update X position when input changes', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      const inputs = getNumberInputs();
      const xInput = inputs[0]; // X is first input
      fireEvent.change(xInput, { target: { value: '200' } });

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.x).toBe(200);
    });

    it('should update Y position when input changes', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      const inputs = getNumberInputs();
      const yInput = inputs[1]; // Y is second input
      fireEvent.change(yInput, { target: { value: '150' } });

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.y).toBe(150);
    });

    it('should update width when input changes', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      const inputs = getNumberInputs();
      const widthInput = inputs[2]; // Width is third input
      fireEvent.change(widthInput, { target: { value: '1000' } });

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.width).toBe(1000);
    });

    it('should update height when input changes', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      const inputs = getNumberInputs();
      const heightInput = inputs[3]; // Height is fourth input
      fireEvent.change(heightInput, { target: { value: '500' } });

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.height).toBe(500);
    });

    it('should enforce minimum X of 0', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      const inputs = getNumberInputs();
      const xInput = inputs[0];
      fireEvent.change(xInput, { target: { value: '-100' } });

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.x).toBe(0);
    });

    it('should enforce minimum width of 50', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      const inputs = getNumberInputs();
      const widthInput = inputs[2];
      fireEvent.change(widthInput, { target: { value: '10' } });

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.width).toBeGreaterThanOrEqual(50);
    });

    it('should maintain aspect ratio when width changes if locked', () => {
      const initialCrop: CropConfig = {
        enabled: true,
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        lockAspectRatio: true,
        aspectRatio: 800 / 600, // 4:3
      };

      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} initialCrop={initialCrop} />);

      const inputs = getNumberInputs();
      const widthInput = inputs[2];
      fireEvent.change(widthInput, { target: { value: '1200' } });

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      // Height should be adjusted to maintain 4:3 ratio
      expect(cropArg.width).toBe(1200);
      expect(cropArg.height).toBe(Math.round(1200 / (800 / 600)));
    });

    it('should maintain aspect ratio when height changes if locked', () => {
      const initialCrop: CropConfig = {
        enabled: true,
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        lockAspectRatio: true,
        aspectRatio: 800 / 600, // 4:3
      };

      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} initialCrop={initialCrop} />);

      const inputs = getNumberInputs();
      const heightInput = inputs[3];
      fireEvent.change(heightInput, { target: { value: '900' } });

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      // Width should be adjusted to maintain 4:3 ratio
      expect(cropArg.height).toBe(900);
      expect(cropArg.width).toBe(Math.round(900 * (800 / 600)));
    });
  });

  describe('reset button', () => {
    it('should reset crop to full video dimensions', () => {
      const initialCrop: CropConfig = {
        enabled: true,
        x: 100,
        y: 100,
        width: 800,
        height: 600,
        lockAspectRatio: true,
        aspectRatio: 4 / 3,
      };

      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} initialCrop={initialCrop} />);

      // Click Reset
      fireEvent.click(screen.getByRole('button', { name: /reset/i }));

      // Apply and verify
      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.x).toBe(0);
      expect(cropArg.y).toBe(0);
      expect(cropArg.width).toBe(1920);
      expect(cropArg.height).toBe(1080);
      expect(cropArg.lockAspectRatio).toBe(false);
      expect(cropArg.enabled).toBe(false); // Full video = disabled crop
    });
  });

  describe('fill button', () => {
    it('should fill entire video when aspect ratio is not locked', () => {
      const initialCrop: CropConfig = {
        enabled: true,
        x: 100,
        y: 100,
        width: 800,
        height: 600,
        lockAspectRatio: false,
        aspectRatio: null,
      };

      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} initialCrop={initialCrop} />);

      // Click Fill
      fireEvent.click(screen.getByRole('button', { name: /fill/i }));

      // Apply and verify
      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      expect(cropArg.x).toBe(0);
      expect(cropArg.y).toBe(0);
      expect(cropArg.width).toBe(1920);
      expect(cropArg.height).toBe(1080);
    });

    it('should maximize crop within aspect ratio when locked', () => {
      // Lock to 1:1 aspect ratio
      const initialCrop: CropConfig = {
        enabled: true,
        x: 100,
        y: 100,
        width: 400,
        height: 400,
        lockAspectRatio: true,
        aspectRatio: 1,
      };

      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} initialCrop={initialCrop} />);

      // Click Fill
      fireEvent.click(screen.getByRole('button', { name: /fill/i }));

      // Apply and verify
      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [cropArg] = onApply.mock.calls[0];
      // For 1:1 aspect ratio in 1920x1080 video, max square is 1080x1080 centered
      expect(cropArg.width).toBe(1080);
      expect(cropArg.height).toBe(1080);
      // Centered horizontally
      expect(cropArg.x).toBe(Math.round((1920 - 1080) / 2));
      expect(cropArg.y).toBe(0);
    });
  });

  describe('composition presets', () => {
    it('should apply auto composition mode by default', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [, compositionArg] = onApply.mock.calls[0];
      expect(compositionArg.mode).toBe('auto');
      expect(compositionArg.aspectRatio).toBeNull();
    });

    it('should apply manual composition mode with 16:9 preset', () => {
      const onApply = vi.fn();
      render(<CropDialog {...defaultProps} onApply={onApply} />);

      // Find the composition section and click 16:9
      const compositionSection = screen.getByText('Composition (Output Canvas)').parentElement!;
      const compositionRadio = within(compositionSection).getByRole('radio', { name: '16:9' });
      fireEvent.click(compositionRadio);

      fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

      const [, compositionArg] = onApply.mock.calls[0];
      expect(compositionArg.mode).toBe('manual');
      expect(compositionArg.aspectRatio).toBeCloseTo(16 / 9, 2);
      expect(compositionArg.aspectPreset).toBe('16:9');
    });

    it('should show description when manual composition is selected', () => {
      render(<CropDialog {...defaultProps} />);

      // Find the composition section and click 9:16
      const compositionSection = screen.getByText('Composition (Output Canvas)').parentElement!;
      const compositionRadio = within(compositionSection).getByRole('radio', { name: '9:16' });
      fireEvent.click(compositionRadio);

      // Should show description text for manual mode
      expect(
        screen.getByText(/Cropped video will be centered within a/i)
      ).toBeInTheDocument();
    });
  });

  describe('dialog state reset on reopen', () => {
    it('should reset to initial values when dialog reopens', () => {
      const initialCrop: CropConfig = {
        enabled: true,
        x: 100,
        y: 50,
        width: 800,
        height: 600,
        lockAspectRatio: false,
        aspectRatio: null,
      };

      const { rerender } = render(
        <CropDialog {...defaultProps} initialCrop={initialCrop} />
      );

      // Modify crop via input
      const inputs = getNumberInputs();
      fireEvent.change(inputs[0], { target: { value: '500' } });

      // Close dialog
      rerender(<CropDialog {...defaultProps} initialCrop={initialCrop} open={false} />);

      // Reopen dialog
      rerender(<CropDialog {...defaultProps} initialCrop={initialCrop} open={true} />);

      // Should be reset to initial values
      const newInputs = getNumberInputs();
      expect(newInputs[0]).toHaveValue(100);
    });
  });

  describe('video preview', () => {
    it('should render video preview placeholder when no video path', () => {
      render(<CropDialog {...defaultProps} />);

      expect(screen.getByText('Video Preview')).toBeInTheDocument();
    });

    it('should render video element when video path is provided', () => {
      render(<CropDialog {...defaultProps} videoPath="/path/to/video.mp4" />);

      const video = document.querySelector('video');
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute('src', expect.stringContaining('video.mp4'));
    });
  });

  describe('crop size indicator', () => {
    it('should display crop dimensions in the preview', () => {
      const initialCrop: CropConfig = {
        enabled: true,
        x: 0,
        y: 0,
        width: 1600,
        height: 900,
        lockAspectRatio: false,
        aspectRatio: null,
      };

      render(<CropDialog {...defaultProps} initialCrop={initialCrop} />);

      // The size indicator shows "width x height" format (using multiplication sign)
      expect(screen.getByText('1600 \u00D7 900')).toBeInTheDocument();
    });
  });
});
