import React, { useCallback } from 'react';
import { Scan, Monitor, ScreenShare, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ShortcutInput } from './ShortcutInput';
import { useSettingsStore, useShortcutsList } from '@/stores/settingsStore';
import { updateShortcut, hasInternalConflict, registerAllShortcuts } from '@/utils/hotkeyManager';
import type { ShortcutConfig } from '@/types';

const SHORTCUT_ICONS: Record<string, React.ReactNode> = {
  new_capture: <Scan className="w-5 h-5" />,
  fullscreen_capture: <Monitor className="w-5 h-5" />,
  all_monitors_capture: <ScreenShare className="w-5 h-5" />,
};

interface ShortcutItemProps {
  config: ShortcutConfig;
}

const ShortcutItem: React.FC<ShortcutItemProps> = ({ config }) => {
  const { resetShortcut, settings } = useSettingsStore();
  const allowOverride = settings.general.allowOverride;

  // Override ON = always green, Override OFF = show actual status
  const showGreen = allowOverride || config.status === 'registered';
  const showWarning = !allowOverride && config.status === 'conflict';

  const handleShortcutChange = useCallback(async (newShortcut: string) => {
    if (hasInternalConflict(newShortcut, config.id)) return;
    await updateShortcut(config.id, newShortcut);
  }, [config.id]);

  const handleReset = useCallback(() => {
    resetShortcut(config.id);
    updateShortcut(config.id, config.defaultShortcut);
  }, [config.id, config.defaultShortcut, resetShortcut]);

  return (
    <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)]">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-white flex items-center justify-center text-[var(--coral-400)] shadow-sm border border-[var(--polar-frost)]">
          {SHORTCUT_ICONS[config.id] || <Scan className="w-5 h-5" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm font-medium text-[var(--ink-black)]">{config.name}</h4>
            {showGreen && <Check className="w-4 h-4 text-emerald-500" />}
            {showWarning && <AlertTriangle className="w-4 h-4 text-amber-500" />}
          </div>
          <p className="text-xs text-[var(--ink-muted)] mb-3">{config.description}</p>

          <ShortcutInput
            value={config.currentShortcut}
            onChange={handleShortcutChange}
            onReset={handleReset}
            status={config.status}
            defaultValue={config.defaultShortcut}
            shortcutId={config.id}
          />
        </div>
      </div>
    </div>
  );
};

export const ShortcutsTab: React.FC = () => {
  const shortcuts = useShortcutsList();
  const { resetAllShortcuts, settings, updateGeneralSettings } = useSettingsStore();

  const handleResetAll = useCallback(async () => {
    resetAllShortcuts();
    for (const config of shortcuts) {
      await updateShortcut(config.id, config.defaultShortcut);
    }
  }, [resetAllShortcuts, shortcuts]);

  const handleOverrideToggle = useCallback(async (enabled: boolean) => {
    updateGeneralSettings({ allowOverride: enabled });
    await registerAllShortcuts();
  }, [updateGeneralSettings]);

  return (
    <div className="space-y-4">
      {/* Global Override Setting */}
      <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)]">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-sm text-[var(--ink-black)]">Allow hotkey override</p>
            <p className="text-xs text-[var(--ink-muted)] mt-0.5">
              Override shortcuts registered by other apps (Windows only)
            </p>
          </div>
          <Switch
            checked={settings.general.allowOverride}
            onCheckedChange={handleOverrideToggle}
          />
        </label>
      </div>

      <div className="space-y-3">
        {shortcuts.map((config) => (
          <ShortcutItem key={config.id} config={config} />
        ))}
      </div>

      <div className="pt-4 border-t border-[var(--polar-frost)]">
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetAll}
          className="text-xs bg-white border-[var(--polar-frost)] text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]"
        >
          Reset All to Defaults
        </Button>
      </div>
    </div>
  );
};
