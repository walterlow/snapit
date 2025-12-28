import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

// Slide animation classes that break center animation
const SLIDE_ANIMATION_CLASSES = [
  'slide-in-from-left',
  'slide-in-from-right',
  'slide-in-from-top',
  'slide-in-from-bottom',
  'slide-out-to-left',
  'slide-out-to-right',
  'slide-out-to-top',
  'slide-out-to-bottom',
];

// Required classes for center animation
const CENTER_ANIMATION_CLASSES = [
  'zoom-in-95',
  'zoom-out-95',
  'fade-in-0',
  'fade-out-0',
];

describe('AlertDialog', () => {
  describe('AlertDialogContent', () => {
    // Regression test: Dialog should animate from center, not slide from edges
    it('should animate from center without slide animations', () => {
      const { baseElement } = render(
        <AlertDialog open>
          <AlertDialogContent data-testid="alert-content">
            <AlertDialogHeader>
              <AlertDialogTitle>Test Title</AlertDialogTitle>
              <AlertDialogDescription>Test description</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Confirm</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      const content = baseElement.querySelector('[data-testid="alert-content"]');
      expect(content).toBeTruthy();

      const classList = content?.className || '';

      // Should NOT have any slide animations (breaks center animation)
      for (const slideClass of SLIDE_ANIMATION_CLASSES) {
        expect(
          classList.includes(slideClass),
          `AlertDialogContent should not have "${slideClass}" - breaks center animation`
        ).toBe(false);
      }
    });

    it('should have zoom and fade animations for center effect', () => {
      const { baseElement } = render(
        <AlertDialog open>
          <AlertDialogContent data-testid="alert-content">
            <AlertDialogHeader>
              <AlertDialogTitle>Test</AlertDialogTitle>
            </AlertDialogHeader>
          </AlertDialogContent>
        </AlertDialog>
      );

      const content = baseElement.querySelector('[data-testid="alert-content"]');
      const classList = content?.className || '';

      // Should have zoom and fade for smooth center animation
      for (const animClass of CENTER_ANIMATION_CLASSES) {
        expect(
          classList.includes(animClass),
          `AlertDialogContent should have "${animClass}" for center animation`
        ).toBe(true);
      }
    });

    it('should be centered with transform translate', () => {
      const { baseElement } = render(
        <AlertDialog open>
          <AlertDialogContent data-testid="alert-content">
            <AlertDialogHeader>
              <AlertDialogTitle>Test</AlertDialogTitle>
            </AlertDialogHeader>
          </AlertDialogContent>
        </AlertDialog>
      );

      const content = baseElement.querySelector('[data-testid="alert-content"]');
      const classList = content?.className || '';

      // Should be positioned at center
      expect(classList).toContain('left-[50%]');
      expect(classList).toContain('top-[50%]');
      expect(classList).toContain('translate-x-[-50%]');
      expect(classList).toContain('translate-y-[-50%]');
    });
  });
});
