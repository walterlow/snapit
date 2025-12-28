import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './tooltip';

// Animation classes that cause duplicate/flash visual bugs when combined
const CONFLICTING_ANIMATION_CLASSES = [
  'animate-in',
  'fade-in',
  'zoom-in',
  'slide-in-from-top',
  'slide-in-from-bottom',
  'slide-in-from-left',
  'slide-in-from-right',
];

describe('Tooltip', () => {
  describe('TooltipContent', () => {
    // Regression test: Multiple stacking animations cause a duplicate/flash effect
    // where the tooltip appears to render twice or flicker on open
    it('should not have conflicting animation classes that cause duplicate visuals', () => {
      const { baseElement } = render(
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>Trigger</TooltipTrigger>
            <TooltipContent data-testid="tooltip-content">
              Content
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );

      const tooltipContent = baseElement.querySelector('[data-testid="tooltip-content"]');
      expect(tooltipContent).toBeTruthy();

      const classList = tooltipContent?.className || '';

      // Check that none of the problematic animation classes are present
      for (const animClass of CONFLICTING_ANIMATION_CLASSES) {
        expect(
          classList.includes(animClass),
          `TooltipContent should not have "${animClass}" class - causes duplicate/flash visual bug`
        ).toBe(false);
      }
    });

    it('should have essential styling classes', () => {
      const { baseElement } = render(
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>Trigger</TooltipTrigger>
            <TooltipContent data-testid="tooltip-content">
              Content
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );

      const tooltipContent = baseElement.querySelector('[data-testid="tooltip-content"]');
      const classList = tooltipContent?.className || '';

      // Essential classes that should be present
      expect(classList).toContain('rounded-lg');
      expect(classList).toContain('bg-neutral-900');
      expect(classList).toContain('text-white');
      expect(classList).toContain('shadow-lg');
    });

    it('should allow custom className without adding animations', () => {
      const { baseElement } = render(
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>Trigger</TooltipTrigger>
            <TooltipContent data-testid="tooltip-content" className="custom-class">
              Content
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );

      const tooltipContent = baseElement.querySelector('[data-testid="tooltip-content"]');
      const classList = tooltipContent?.className || '';

      expect(classList).toContain('custom-class');

      // Still should not have animation classes even with custom className
      for (const animClass of CONFLICTING_ANIMATION_CLASSES) {
        expect(classList.includes(animClass)).toBe(false);
      }
    });

    // Regression test: Tooltip should NOT use Portal to prevent orphaned elements
    // When parent components unmount during navigation, portals can get stuck
    // visible because they render to document.body outside the React tree
    it('should not render in a portal to prevent stuck tooltips on unmount', () => {
      const { container, baseElement } = render(
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>Trigger</TooltipTrigger>
            <TooltipContent data-testid="tooltip-content">
              Content
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );

      const tooltipContent = baseElement.querySelector('[data-testid="tooltip-content"]');
      expect(tooltipContent).toBeTruthy();

      // Tooltip should be inside the container (not portaled to body)
      // This ensures it unmounts with its parent component
      const tooltipInContainer = container.querySelector('[data-testid="tooltip-content"]');
      expect(
        tooltipInContainer,
        'TooltipContent should render inside container, not in a portal to document.body'
      ).toBeTruthy();
    });
  });
});
