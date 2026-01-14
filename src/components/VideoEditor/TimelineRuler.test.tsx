import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimelineRuler } from './TimelineRuler';

describe('TimelineRuler', () => {
  describe('rendering', () => {
    it('should render with correct width', () => {
      const { container } = render(
        <TimelineRuler durationMs={10000} timelineZoom={0.1} width={1000} />
      );

      const ruler = container.firstChild as HTMLElement;
      expect(ruler.style.width).toBe('1000px');
    });

    it('should render time labels for major ticks', () => {
      // With zoom = 0.1 px/ms, pxPerSecond = 100, so majorMs = 1000 (1 second)
      render(
        <TimelineRuler durationMs={5000} timelineZoom={0.1} width={500} />
      );

      // Should have labels at 0:00, 0:01, 0:02, 0:03, 0:04, 0:05
      expect(screen.getByText('0:00')).toBeInTheDocument();
      expect(screen.getByText('0:01')).toBeInTheDocument();
      expect(screen.getByText('0:02')).toBeInTheDocument();
    });
  });

  describe('tick calculations', () => {
    it('should generate ticks from 0 to duration', () => {
      const { container } = render(
        <TimelineRuler durationMs={3000} timelineZoom={0.1} width={300} />
      );

      // With pxPerSecond = 100, minorMs = 500
      // Ticks at: 0, 500, 1000, 1500, 2000, 2500, 3000 = 7 ticks
      const ticks = container.querySelectorAll('.absolute.inset-y-0');
      expect(ticks.length).toBe(7);
    });

    it('should use different intervals at low zoom', () => {
      // With zoom = 0.01 px/ms, pxPerSecond = 10, majorMs = 30000
      const { container } = render(
        <TimelineRuler durationMs={60000} timelineZoom={0.01} width={600} />
      );

      // Minor ticks at 10 second intervals
      // 0, 10000, 20000, 30000, 40000, 50000, 60000 = 7 ticks
      const ticks = container.querySelectorAll('.absolute.inset-y-0');
      expect(ticks.length).toBe(7);
    });

    it('should position ticks correctly based on timelineZoom', () => {
      const { container } = render(
        <TimelineRuler durationMs={2000} timelineZoom={0.1} width={200} />
      );

      const ticks = container.querySelectorAll('.absolute.inset-y-0');

      // First tick at 0ms -> 0px
      expect((ticks[0] as HTMLElement).style.left).toBe('0px');

      // Tick at 1000ms -> 100px (1000 * 0.1)
      const tick1000 = Array.from(ticks).find(
        (t) => (t as HTMLElement).style.left === '100px'
      );
      expect(tick1000).toBeTruthy();
    });
  });

  describe('major vs minor ticks', () => {
    it('should style major ticks differently', () => {
      const { container } = render(
        <TimelineRuler durationMs={2000} timelineZoom={0.1} width={200} />
      );

      // Major ticks should have taller lines (h-3)
      const majorLines = container.querySelectorAll('.h-3');
      expect(majorLines.length).toBeGreaterThan(0);

      // Minor ticks should have shorter lines (h-2)
      const minorLines = container.querySelectorAll('.h-2');
      expect(minorLines.length).toBeGreaterThan(0);
    });

    it('should only show labels on major ticks', () => {
      const { container } = render(
        <TimelineRuler durationMs={2000} timelineZoom={0.1} width={200} />
      );

      // Labels should be present
      const labels = container.querySelectorAll('.text-\\[10px\\]');
      
      // With pxPerSecond = 100, majorMs = 1000, duration = 2000
      // Major ticks at: 0, 1000, 2000 = 3 labels
      expect(labels.length).toBe(3);
    });
  });

  describe('zoom level intervals', () => {
    it('should use 30s/10s intervals at very low zoom (< 20 px/sec)', () => {
      // timelineZoom = 0.005, pxPerSecond = 5
      render(
        <TimelineRuler durationMs={120000} timelineZoom={0.005} width={600} />
      );

      // Should show labels at 30 second intervals: 0:00, 0:30, 1:00, 1:30, 2:00
      expect(screen.getByText('0:00')).toBeInTheDocument();
      expect(screen.getByText('0:30')).toBeInTheDocument();
      expect(screen.getByText('1:00')).toBeInTheDocument();
    });

    it('should use 10s/5s intervals at low zoom (20-50 px/sec)', () => {
      // timelineZoom = 0.03, pxPerSecond = 30
      render(
        <TimelineRuler durationMs={30000} timelineZoom={0.03} width={900} />
      );

      // Should show labels at 10 second intervals
      expect(screen.getByText('0:00')).toBeInTheDocument();
      expect(screen.getByText('0:10')).toBeInTheDocument();
      expect(screen.getByText('0:20')).toBeInTheDocument();
    });

    it('should use 5s/1s intervals at medium zoom (50-100 px/sec)', () => {
      // timelineZoom = 0.06, pxPerSecond = 60
      render(
        <TimelineRuler durationMs={15000} timelineZoom={0.06} width={900} />
      );

      // Should show labels at 5 second intervals
      expect(screen.getByText('0:00')).toBeInTheDocument();
      expect(screen.getByText('0:05')).toBeInTheDocument();
      expect(screen.getByText('0:10')).toBeInTheDocument();
    });

    it('should use 1s/0.5s intervals at high zoom (>= 100 px/sec)', () => {
      // timelineZoom = 0.15, pxPerSecond = 150
      render(
        <TimelineRuler durationMs={5000} timelineZoom={0.15} width={750} />
      );

      // Should show labels at 1 second intervals
      expect(screen.getByText('0:00')).toBeInTheDocument();
      expect(screen.getByText('0:01')).toBeInTheDocument();
      expect(screen.getByText('0:02')).toBeInTheDocument();
    });
  });
});
