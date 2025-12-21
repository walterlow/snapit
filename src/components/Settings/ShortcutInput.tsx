import React, { useState, useEffect, useCallback } from 'react';
import { RotateCcw, ChevronDown, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { checkShortcutConflict } from '@/utils/hotkeyManager';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ShortcutStatus } from '@/types';

interface ShortcutInputProps {
  value: string;
  onChange: (shortcut: string) => void;
  onReset?: () => void;
  status?: ShortcutStatus;
  disabled?: boolean;
  showReset?: boolean;
  defaultValue?: string;
  shortcutId?: string; // Used to exclude self from internal conflict check
}

type ConflictStatus = 'unchecked' | 'checking' | 'available' | 'conflict' | 'internal_conflict';

// Available keys for the dropdown
const KEY_GROUPS = {
  special: [
    { value: 'PrintScreen', label: 'Print Screen' },
  ],
  letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(k => ({ value: k, label: k })),
  numbers: '0123456789'.split('').map(k => ({ value: k, label: k })),
  functionKeys: Array.from({ length: 12 }, (_, i) => ({ value: `F${i + 1}`, label: `F${i + 1}` })),
  navigation: [
    { value: 'Space', label: 'Space' },
    { value: 'Enter', label: 'Enter' },
    { value: 'Tab', label: 'Tab' },
    { value: 'Escape', label: 'Escape' },
    { value: 'Backspace', label: 'Backspace' },
    { value: 'Delete', label: 'Delete' },
    { value: 'Insert', label: 'Insert' },
    { value: 'Home', label: 'Home' },
    { value: 'End', label: 'End' },
    { value: 'PageUp', label: 'Page Up' },
    { value: 'PageDown', label: 'Page Down' },
  ],
  arrows: [
    { value: 'ArrowUp', label: 'Up' },
    { value: 'ArrowDown', label: 'Down' },
    { value: 'ArrowLeft', label: 'Left' },
    { value: 'ArrowRight', label: 'Right' },
  ],
};

// Flat list for label lookup
const ALL_KEYS = [
  ...KEY_GROUPS.special,
  ...KEY_GROUPS.letters,
  ...KEY_GROUPS.numbers,
  ...KEY_GROUPS.functionKeys,
  ...KEY_GROUPS.navigation,
  ...KEY_GROUPS.arrows,
];

// Parse shortcut string into components
function parseShortcut(shortcut: string): { ctrl: boolean; shift: boolean; alt: boolean; key: string } {
  if (!shortcut) return { ctrl: false, shift: false, alt: false, key: '' };
  
  const parts = shortcut.split('+').map(p => p.trim());
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map(m => m.toLowerCase());
  
  return {
    ctrl: modifiers.some(m => m === 'ctrl' || m === 'control' || m === 'commandorcontrol'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt'),
    key: key || '',
  };
}

// Build shortcut string from components
function buildShortcut(ctrl: boolean, shift: boolean, alt: boolean, key: string): string {
  if (!key) return '';
  
  const parts: string[] = [];
  if (ctrl) parts.push('Ctrl');
  if (shift) parts.push('Shift');
  if (alt) parts.push('Alt');
  parts.push(key);
  
  return parts.join('+');
}

// Get display label for a key value
function getKeyLabel(key: string): string {
  const option = ALL_KEYS.find(o => o.value === key);
  return option?.label || key || 'None';
}

export const ShortcutInput: React.FC<ShortcutInputProps> = ({
  value,
  onChange,
  onReset,
  status = 'pending',
  disabled = false,
  showReset = true,
  defaultValue,
  shortcutId,
}) => {
  // Local state for pending changes
  const [localCtrl, setLocalCtrl] = useState(false);
  const [localShift, setLocalShift] = useState(false);
  const [localAlt, setLocalAlt] = useState(false);
  const [localKey, setLocalKey] = useState('');
  const [conflictStatus, setConflictStatus] = useState<ConflictStatus>('unchecked');

  // Initialize local state from value prop
  useEffect(() => {
    const parsed = parseShortcut(value);
    setLocalCtrl(parsed.ctrl);
    setLocalShift(parsed.shift);
    setLocalAlt(parsed.alt);
    setLocalKey(parsed.key);
    setConflictStatus('unchecked');
  }, [value]);

  // Reset conflict status when shortcut gets registered successfully
  useEffect(() => {
    if (status === 'registered') {
      setConflictStatus('unchecked');
    }
  }, [status]);

  // Build current local shortcut
  const localShortcut = buildShortcut(localCtrl, localShift, localAlt, localKey);
  
  // Check if there are pending changes
  const hasPendingChanges = localShortcut !== value && localShortcut !== '';
  
  // Check if shortcut is valid (just needs a key)
  const isValid = localKey !== '';

  // Check for conflicts when local shortcut changes
  const checkConflicts = useCallback(async () => {
    if (!localShortcut || localShortcut === value) {
      setConflictStatus('unchecked');
      return;
    }

    setConflictStatus('checking');
    
    try {
      const result = await checkShortcutConflict(localShortcut, shortcutId);
      setConflictStatus(result === 'error' ? 'conflict' : result);
    } catch (error) {
      console.error('Error checking conflict:', error);
      setConflictStatus('conflict');
    }
  }, [localShortcut, value, shortcutId]);

  // Debounced conflict check when shortcut changes
  useEffect(() => {
    if (!hasPendingChanges) {
      setConflictStatus('unchecked');
      return;
    }

    const timer = setTimeout(() => {
      checkConflicts();
    }, 300); // Debounce 300ms

    return () => clearTimeout(timer);
  }, [hasPendingChanges, checkConflicts]);

  const { updateGeneralSettings, settings } = useSettingsStore();
  const allowOverride = settings.general.allowOverride;

  const handleApply = () => {
    if (disabled || !isValid) return;
    onChange(localShortcut);
  };

  const handleApplyOverride = () => {
    if (disabled || !isValid) return;
    // Enable global override setting, then apply shortcut
    updateGeneralSettings({ allowOverride: true });
    onChange(localShortcut);
  };

  const handleKeyChange = (newKey: string) => {
    if (disabled) return;
    if (newKey === 'none') {
      setLocalKey('');
      return;
    }
    setLocalKey(newKey);
  };

  const isModifiedFromDefault = defaultValue && value !== defaultValue;
  
  const getBorderClass = () => {
    // When editing, show pending state
    if (hasPendingChanges) {
      if (conflictStatus === 'internal_conflict') return 'border-red-500/70';
      if (conflictStatus === 'checking') return 'border-[var(--coral-400)]/50';
      return 'border-[var(--coral-400)]/70';
    }

    // Override ON = always green (we're forcing it anyway)
    if (allowOverride) return 'border-emerald-500/50';

    // Override OFF = show actual status
    if (status === 'registered') return 'border-emerald-500/50';
    if (status === 'conflict' || status === 'error') return 'border-red-500/50';
    return 'border-[var(--polar-frost)]';
  };

  return (
    <div className="space-y-2">
      <div
        className={cn(
          'flex items-center gap-1.5 p-2 rounded-lg border transition-colors',
          'bg-white',
          getBorderClass(),
          disabled && 'opacity-50'
        )}
      >
        {/* Ctrl checkbox */}
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={localCtrl}
            onChange={(e) => setLocalCtrl(e.target.checked)}
            disabled={disabled}
            className={cn(
              'w-4 h-4 rounded border cursor-pointer appearance-none',
              'border-[var(--polar-frost)] bg-[var(--polar-ice)]',
              'checked:bg-[var(--coral-400)] checked:border-[var(--coral-400)]',
              'focus:ring-2 focus:ring-[var(--coral-400)]/30 focus:ring-offset-0',
              'relative',
              'checked:after:content-["✓"] checked:after:absolute checked:after:inset-0',
              'checked:after:flex checked:after:items-center checked:after:justify-center',
              'checked:after:text-[10px] checked:after:text-white checked:after:font-bold'
            )}
          />
          <span className="text-xs text-[var(--ink-dark)]">Ctrl</span>
        </label>

        <span className="text-[var(--ink-muted)] text-xs px-0.5">+</span>

        {/* Shift checkbox */}
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={localShift}
            onChange={(e) => setLocalShift(e.target.checked)}
            disabled={disabled}
            className={cn(
              'w-4 h-4 rounded border cursor-pointer appearance-none',
              'border-[var(--polar-frost)] bg-[var(--polar-ice)]',
              'checked:bg-[var(--coral-400)] checked:border-[var(--coral-400)]',
              'focus:ring-2 focus:ring-[var(--coral-400)]/30 focus:ring-offset-0',
              'relative',
              'checked:after:content-["✓"] checked:after:absolute checked:after:inset-0',
              'checked:after:flex checked:after:items-center checked:after:justify-center',
              'checked:after:text-[10px] checked:after:text-white checked:after:font-bold'
            )}
          />
          <span className="text-xs text-[var(--ink-dark)]">Shift</span>
        </label>

        <span className="text-[var(--ink-muted)] text-xs px-0.5">+</span>

        {/* Alt checkbox */}
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={localAlt}
            onChange={(e) => setLocalAlt(e.target.checked)}
            disabled={disabled}
            className={cn(
              'w-4 h-4 rounded border cursor-pointer appearance-none',
              'border-[var(--polar-frost)] bg-[var(--polar-ice)]',
              'checked:bg-[var(--coral-400)] checked:border-[var(--coral-400)]',
              'focus:ring-2 focus:ring-[var(--coral-400)]/30 focus:ring-offset-0',
              'relative',
              'checked:after:content-["✓"] checked:after:absolute checked:after:inset-0',
              'checked:after:flex checked:after:items-center checked:after:justify-center',
              'checked:after:text-[10px] checked:after:text-white checked:after:font-bold'
            )}
          />
          <span className="text-xs text-[var(--ink-dark)]">Alt</span>
        </label>
        
        <span className="text-[var(--ink-muted)] text-xs px-0.5">+</span>

        {/* Key dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <button
              className={cn(
                'flex items-center justify-between gap-2 h-7 px-2 min-w-[100px]',
                'rounded-lg border text-xs',
                'bg-[var(--polar-ice)] border-[var(--polar-frost)]',
                'hover:bg-[var(--polar-mist)] hover:border-[var(--ink-subtle)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--coral-400)]/30',
                disabled && 'pointer-events-none opacity-50'
              )}
            >
              <span className="text-[var(--ink-black)]">{getKeyLabel(localKey)}</span>
              <ChevronDown className="w-3 h-3 text-[var(--ink-muted)]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="max-h-[300px] overflow-y-auto bg-white border-[var(--polar-frost)]"
            align="start"
          >
            <DropdownMenuRadioGroup value={localKey || 'none'} onValueChange={handleKeyChange}>
              <DropdownMenuRadioItem value="none" className="text-xs text-[var(--ink-muted)]">
                None
              </DropdownMenuRadioItem>

              <DropdownMenuSeparator />

              <DropdownMenuLabel className="text-xs text-[var(--coral-400)]">Special</DropdownMenuLabel>
              {KEY_GROUPS.special.map(opt => (
                <DropdownMenuRadioItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}

              <DropdownMenuSeparator />

              <DropdownMenuLabel className="text-xs text-[var(--coral-400)]">Letters</DropdownMenuLabel>
              {KEY_GROUPS.letters.map(opt => (
                <DropdownMenuRadioItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}

              <DropdownMenuSeparator />

              <DropdownMenuLabel className="text-xs text-[var(--coral-400)]">Numbers</DropdownMenuLabel>
              {KEY_GROUPS.numbers.map(opt => (
                <DropdownMenuRadioItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}

              <DropdownMenuSeparator />

              <DropdownMenuLabel className="text-xs text-[var(--coral-400)]">Function Keys</DropdownMenuLabel>
              {KEY_GROUPS.functionKeys.map(opt => (
                <DropdownMenuRadioItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}

              <DropdownMenuSeparator />

              <DropdownMenuLabel className="text-xs text-[var(--coral-400)]">Navigation</DropdownMenuLabel>
              {KEY_GROUPS.navigation.map(opt => (
                <DropdownMenuRadioItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}

              <DropdownMenuSeparator />

              <DropdownMenuLabel className="text-xs text-[var(--coral-400)]">Arrows</DropdownMenuLabel>
              {KEY_GROUPS.arrows.map(opt => (
                <DropdownMenuRadioItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        
        {/* Conflict status indicator */}
        {conflictStatus === 'checking' && (
          <Loader2 className="w-4 h-4 text-[var(--coral-400)] animate-spin ml-1" />
        )}
        {conflictStatus === 'available' && hasPendingChanges && (
          <Check className="w-4 h-4 text-emerald-500 ml-1" />
        )}
        {(conflictStatus === 'conflict' || conflictStatus === 'internal_conflict') && (
          <AlertTriangle className="w-4 h-4 text-red-500 ml-1" />
        )}

        {/* Apply button - for available shortcuts OR conflicts when override is already enabled */}
        {hasPendingChanges && conflictStatus !== 'internal_conflict' && (conflictStatus !== 'conflict' || allowOverride) && (
          <Button
            variant="default"
            size="sm"
            onClick={handleApply}
            disabled={disabled || !isValid || conflictStatus === 'checking'}
            className="h-7 px-2 ml-1 text-xs bg-[var(--coral-400)] hover:bg-[var(--coral-500)] text-white"
            title="Apply shortcut"
          >
            <Check className="w-3 h-3 mr-1" />
            Apply
          </Button>
        )}

        {/* Apply Override button - for external conflicts when override is OFF */}
        {hasPendingChanges && conflictStatus === 'conflict' && !allowOverride && (
          <Button
            variant="default"
            size="sm"
            onClick={handleApplyOverride}
            disabled={disabled || !isValid}
            className="h-7 px-3 ml-1 text-xs bg-red-500 hover:bg-red-600 text-white"
            title="Enable hotkey override and apply"
          >
            <Check className="w-3 h-3 mr-1" />
            Apply Override
          </Button>
        )}

        {/* Reset button */}
        {showReset && isModifiedFromDefault && !hasPendingChanges && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onReset}
            disabled={disabled}
            className="h-7 w-7 ml-1 text-[var(--ink-muted)] hover:text-[var(--ink-black)]"
            title="Reset to default"
          >
            <RotateCcw className="w-3 h-3" />
          </Button>
        )}
      </div>

      {/* Conflict warning message */}
      {conflictStatus === 'conflict' && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          Shortcut in use by another app.
        </p>
      )}
      {conflictStatus === 'internal_conflict' && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          This shortcut is already used by another SnapIt action
        </p>
      )}
      {conflictStatus === 'available' && hasPendingChanges && (
        <p className="text-xs text-emerald-500 flex items-center gap-1">
          <Check className="w-3 h-3" />
          Shortcut is available
        </p>
      )}
    </div>
  );
};
