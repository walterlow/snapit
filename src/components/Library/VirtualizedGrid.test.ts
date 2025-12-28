import { describe, it, expect } from 'vitest';
import { getColumnsForWidth, getCardWidth, calculateRowHeight } from './VirtualizedGrid';

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
});
