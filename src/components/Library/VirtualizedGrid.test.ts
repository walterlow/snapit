import { describe, it, expect } from 'vitest';
import { getColumnsForWidth, getCardWidth, calculateRowHeight, getGridWidth } from './VirtualizedGrid';

describe('VirtualizedGrid', () => {
  describe('getColumnsForWidth', () => {
    it('returns 5 columns for width >= 1600', () => {
      expect(getColumnsForWidth(1600)).toBe(5);
      expect(getColumnsForWidth(1920)).toBe(5);
      expect(getColumnsForWidth(2560)).toBe(5);
    });

    it('returns 4 columns for width >= 1200 and < 1600', () => {
      expect(getColumnsForWidth(1200)).toBe(4);
      expect(getColumnsForWidth(1400)).toBe(4);
      expect(getColumnsForWidth(1599)).toBe(4);
    });

    it('returns 3 columns for width < 1200', () => {
      expect(getColumnsForWidth(800)).toBe(3);
      expect(getColumnsForWidth(1000)).toBe(3);
      expect(getColumnsForWidth(1199)).toBe(3);
    });
  });

  describe('getCardWidth', () => {
    it('calculates card width to fill available space', () => {
      // At 1200px with 4 cols: (1200 - 64 - 60) / 4 = 269px
      expect(getCardWidth(1200, 4)).toBe(269);
    });

    it('caps card width at MAX_CARD_WIDTH (320px)', () => {
      // At 2560px with 5 cols: (2560 - 64 - 80) / 5 = 483px -> capped to 320
      expect(getCardWidth(2560, 5)).toBe(320);
      expect(getCardWidth(3000, 5)).toBe(320);
    });

    it('allows smaller widths when container is small', () => {
      // At 800px with 3 cols: (800 - 64 - 40) / 3 = 232px
      expect(getCardWidth(800, 3)).toBe(232);
    });
  });

  describe('calculateRowHeight', () => {
    it('calculates row height based on card width (16:9 + footer + gap)', () => {
      // Card width 269px -> thumbnail 151px + footer 80px + gap 20px = 251px
      const height = calculateRowHeight(1200, 4);
      expect(height).toBe(251);
    });

    it('has consistent height when cards are at max width', () => {
      // Card width 320px -> thumbnail 180px + footer 80px + gap 20px = 280px
      expect(calculateRowHeight(2560, 5)).toBe(280);
      expect(calculateRowHeight(3000, 5)).toBe(280);
    });
  });

  describe('getGridWidth', () => {
    it('calculates total grid width from columns and card width', () => {
      // At 1200px with 4 cols: cardWidth=269, gridWidth = 4*269 + 3*20 = 1076 + 60 = 1136
      expect(getGridWidth(1200, 4)).toBe(1136);
    });

    it('uses capped card width when calculating grid width', () => {
      // At 2560px with 5 cols: cardWidth=320 (capped), gridWidth = 5*320 + 4*20 = 1600 + 80 = 1680
      expect(getGridWidth(2560, 5)).toBe(1680);
      // Same result for larger container since card width is capped
      expect(getGridWidth(3000, 5)).toBe(1680);
    });

    it('is narrower than container when cards are at max width', () => {
      // At 2560px: available = 2560-64=2496, gridWidth=1680, so grid is centered
      const containerWidth = 2560;
      const cols = 5;
      const gridWidth = getGridWidth(containerWidth, cols);
      const availableWidth = containerWidth - 64; // CONTAINER_PADDING
      expect(gridWidth).toBeLessThan(availableWidth);
    });
  });
});
