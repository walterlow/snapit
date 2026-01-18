import React from 'react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';
import type { ImageFormat } from '@/types';

export const ScreenshotsTab: React.FC = () => {
  const { settings, updateGeneralSettings } = useSettingsStore();
  const { general } = settings;
  const { copyToClipboardAfterCapture, setCopyToClipboardAfterCapture } = useCaptureSettingsStore();

  const handleFormatChange = (format: ImageFormat) => {
    updateGeneralSettings({ imageFormat: format });
  };

  const handleQualityChange = (value: number[]) => {
    updateGeneralSettings({ jpgQuality: value[0] });
  };

  return (
    <div className="space-y-6">
      {/* Image Format Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
          Image Format
        </h3>
        <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)] space-y-4">
          {/* Image Format */}
          <div>
            <label className="text-sm text-[var(--ink-black)] mb-2 block">
              Default image format
            </label>
            <Select
              value={general.imageFormat}
              onValueChange={(value) => handleFormatChange(value as ImageFormat)}
            >
              <SelectTrigger className="w-full max-w-[200px] bg-[var(--card)] border-[var(--polar-frost)] text-[var(--ink-black)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">PNG - Lossless</SelectItem>
                <SelectItem value="jpg">JPG - Compressed</SelectItem>
                <SelectItem value="webp">WebP - Modern</SelectItem>
                <SelectItem value="gif">GIF - Legacy</SelectItem>
                <SelectItem value="bmp">BMP - Uncompressed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* JPG Quality (only visible when JPG is selected) */}
          {general.imageFormat === 'jpg' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-[var(--ink-black)]">
                  JPG Quality
                </label>
                <span className="text-sm text-[var(--ink-muted)]">
                  {general.jpgQuality}%
                </span>
              </div>
              <Slider
                value={[general.jpgQuality]}
                onValueChange={handleQualityChange}
                min={10}
                max={100}
                step={5}
                className="w-full"
              />
              <p className="text-xs text-[var(--ink-muted)] mt-1">
                Higher quality = larger file size
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Behavior Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
          Behavior
        </h3>
        <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)] space-y-4">
          {/* Copy to Clipboard */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-[var(--ink-black)] block">
                Copy to clipboard after capture
              </label>
              <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                Automatically copy screenshots to clipboard
              </p>
            </div>
            <Switch
              checked={copyToClipboardAfterCapture}
              onCheckedChange={setCopyToClipboardAfterCapture}
            />
          </div>
        </div>
      </section>
    </div>
  );
};
