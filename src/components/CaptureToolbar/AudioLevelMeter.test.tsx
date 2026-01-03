import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AudioLevelMeter } from './AudioLevelMeter';

// Mock the useAudioLevel hook
vi.mock('@/hooks/useAudioLevel', () => ({
  useAudioLevel: vi.fn(() => ({
    level: 0,
    isActive: false,
  })),
}));

describe('AudioLevelMeter', () => {
  describe('rendering', () => {
    it('should render when enabled with external level', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={0.5} />
      );

      const meter = container.querySelector('.glass-audio-meter');
      expect(meter).toBeInTheDocument();
    });

    it('should not render when disabled', () => {
      const { container } = render(
        <AudioLevelMeter enabled={false} level={0.5} />
      );

      const meter = container.querySelector('.glass-audio-meter');
      expect(meter).not.toBeInTheDocument();
    });

    it('should not render in self-managed mode without deviceIndex', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} deviceIndex={null} />
      );

      const meter = container.querySelector('.glass-audio-meter');
      expect(meter).not.toBeInTheDocument();
    });

    it('should not render in self-managed mode with undefined deviceIndex', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} deviceIndex={undefined} />
      );

      const meter = container.querySelector('.glass-audio-meter');
      expect(meter).not.toBeInTheDocument();
    });
  });

  describe('external level mode', () => {
    it('should display fill based on external level', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={0.75} />
      );

      const fill = container.querySelector('.glass-audio-meter-fill') as HTMLElement;
      expect(fill).toBeInTheDocument();
      expect(fill.style.width).toBe('75%');
    });

    it('should show 0% fill for level 0', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={0} />
      );

      const fill = container.querySelector('.glass-audio-meter-fill') as HTMLElement;
      expect(fill.style.width).toBe('0%');
    });

    it('should show 100% fill for level 1', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={1} />
      );

      const fill = container.querySelector('.glass-audio-meter-fill') as HTMLElement;
      expect(fill.style.width).toBe('100%');
    });

    it('should round fill percentage', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={0.333} />
      );

      const fill = container.querySelector('.glass-audio-meter-fill') as HTMLElement;
      expect(fill.style.width).toBe('33%');
    });
  });

  describe('title attribute', () => {
    it('should show audio level in title when active', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={0.5} />
      );

      const meter = container.querySelector('.glass-audio-meter');
      expect(meter?.getAttribute('title')).toBe('Audio level: 50%');
    });
  });

  describe('className prop', () => {
    it('should apply custom className', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={0.5} className="custom-class" />
      );

      const meter = container.querySelector('.glass-audio-meter');
      expect(meter?.className).toContain('custom-class');
    });

    it('should preserve base class when adding custom className', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={0.5} className="custom-class" />
      );

      const meter = container.querySelector('.glass-audio-meter');
      expect(meter?.className).toContain('glass-audio-meter');
    });
  });

  describe('defaults', () => {
    it('should be enabled by default', () => {
      const { container } = render(
        <AudioLevelMeter level={0.5} />
      );

      const meter = container.querySelector('.glass-audio-meter');
      expect(meter).toBeInTheDocument();
    });

    it('should have empty className by default', () => {
      const { container } = render(
        <AudioLevelMeter enabled={true} level={0.5} />
      );

      const meter = container.querySelector('.glass-audio-meter');
      // Should only have base class with trailing space from template literal
      expect(meter?.className.trim()).toBe('glass-audio-meter');
    });
  });
});
