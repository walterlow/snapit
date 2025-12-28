import { describe, it, expect } from 'vitest';
import { getColumnsForWidth } from './VirtualizedGrid';

describe('VirtualizedGrid', () => {
  describe('getColumnsForWidth', () => {
    it('returns 6 columns for width >= 1800', () => {
      expect(getColumnsForWidth(1800)).toBe(6);
      expect(getColumnsForWidth(2000)).toBe(6);
      expect(getColumnsForWidth(2560)).toBe(6);
    });

    it('returns 5 columns for width >= 1400 and < 1800', () => {
      expect(getColumnsForWidth(1400)).toBe(5);
      expect(getColumnsForWidth(1600)).toBe(5);
      expect(getColumnsForWidth(1799)).toBe(5);
    });

    it('returns 4 columns for width >= 1100 and < 1400', () => {
      expect(getColumnsForWidth(1100)).toBe(4);
      expect(getColumnsForWidth(1200)).toBe(4);
      expect(getColumnsForWidth(1399)).toBe(4);
    });

    it('returns 3 columns for width >= 800 and < 1100', () => {
      expect(getColumnsForWidth(800)).toBe(3);
      expect(getColumnsForWidth(900)).toBe(3);
      expect(getColumnsForWidth(1099)).toBe(3);
    });

    it('returns 2 columns for width >= 500 and < 800', () => {
      expect(getColumnsForWidth(500)).toBe(2);
      expect(getColumnsForWidth(600)).toBe(2);
      expect(getColumnsForWidth(799)).toBe(2);
    });

    it('returns 1 column for width < 500', () => {
      expect(getColumnsForWidth(499)).toBe(1);
      expect(getColumnsForWidth(300)).toBe(1);
      expect(getColumnsForWidth(0)).toBe(1);
    });

    // Regression test: marquee selection must use the same column calculation
    // as VirtualizedGrid to ensure accurate selection bounds
    it('provides consistent breakpoints for marquee selection sync', () => {
      // These breakpoints must match exactly between VirtualizedGrid and
      // CaptureLibrary's virtualLayout calculation
      const breakpoints = [
        { width: 1800, expectedCols: 6 },
        { width: 1400, expectedCols: 5 },
        { width: 1100, expectedCols: 4 },
        { width: 800, expectedCols: 3 },
        { width: 500, expectedCols: 2 },
        { width: 0, expectedCols: 1 },
      ];

      for (const { width, expectedCols } of breakpoints) {
        expect(
          getColumnsForWidth(width),
          `Width ${width} should have ${expectedCols} columns`
        ).toBe(expectedCols);
      }
    });
  });
});
