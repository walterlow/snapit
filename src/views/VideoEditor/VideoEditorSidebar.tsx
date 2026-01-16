/**
 * VideoEditorSidebar - Right sidebar with tabbed properties panel.
 * Contains Project, Cursor, Webcam, Style, and Export tabs.
 */
import { useState } from 'react';
import { Circle, Square, Monitor, Crop } from 'lucide-react';
import { useVideoEditorStore } from '../../stores/videoEditorStore';
import { BackgroundSettings } from '../../components/VideoEditor/BackgroundSettings';
import { Button } from '../../components/ui/button';
import { Slider } from '../../components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { PositionGrid } from './PositionGrid';
import { ZoomRegionConfig } from './ZoomRegionConfig';
import { MaskSegmentConfig } from './MaskSegmentConfig';
import { TextSegmentConfig } from './TextSegmentConfig';
import type { WebcamOverlayShape, AspectRatio, ExportPreset, SceneMode, VideoProject } from '../../types';

export interface VideoEditorSidebarProps {
  project: VideoProject | null;
  onOpenCropDialog: () => void;
}

type PropertiesTab = 'project' | 'cursor' | 'webcam' | 'background' | 'export';

export function VideoEditorSidebar({ project, onOpenCropDialog }: VideoEditorSidebarProps) {
  const {
    updateWebcamConfig,
    updateExportConfig,
    updateCursorConfig,
    updateAudioConfig,
    // Zoom region
    selectedZoomRegionId,
    selectZoomRegion,
    updateZoomRegion,
    deleteZoomRegion,
    // Scene segment
    selectedSceneSegmentId,
    selectSceneSegment,
    updateSceneSegment,
    deleteSceneSegment,
    // Mask segment
    selectedMaskSegmentId,
    selectMaskSegment,
    updateMaskSegment,
    deleteMaskSegment,
    // Text segment
    selectedTextSegmentId,
    selectTextSegment,
    updateTextSegment,
    deleteTextSegment,
  } = useVideoEditorStore();

  // Properties panel tab state
  const [activeTab, setActiveTab] = useState<PropertiesTab>('project');

  return (
    <div className="w-92 compositor-sidebar flex flex-col">
      {/* Tab Bar - scrollable to prevent clipping */}
      <div className="flex overflow-x-auto border-b border-[var(--glass-border)] scrollbar-none">
        <button
          onClick={() => setActiveTab('project')}
          className={`flex-shrink-0 px-2.5 py-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
            activeTab === 'project'
              ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
              : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
          }`}
        >
          Project
        </button>
        {project?.sources.cursorData && (
          <button
            onClick={() => setActiveTab('cursor')}
            className={`flex-shrink-0 px-2.5 py-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
              activeTab === 'cursor'
                ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
                : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
            }`}
          >
            Cursor
          </button>
        )}
        {project?.sources.webcamVideo && (
          <button
            onClick={() => setActiveTab('webcam')}
            className={`flex-shrink-0 px-2.5 py-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
              activeTab === 'webcam'
                ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
                : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
            }`}
          >
            Webcam
          </button>
        )}
        <button
          onClick={() => setActiveTab('background')}
          className={`flex-shrink-0 px-2.5 py-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
            activeTab === 'background'
              ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
              : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
          }`}
        >
          Style
        </button>
        <button
          onClick={() => setActiveTab('export')}
          className={`flex-shrink-0 px-2.5 py-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
            activeTab === 'export'
              ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
              : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
          }`}
        >
          Export
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto relative">
        {/* Selection Overlay (shown when zoom region, scene segment, mask, or text is selected) */}
        {(selectedZoomRegionId || selectedSceneSegmentId || selectedMaskSegmentId || selectedTextSegmentId) && project && (
          <div className="absolute inset-0 p-4 bg-[var(--glass-surface-dark)] z-10 animate-in slide-in-from-bottom-2 fade-in duration-200 overflow-y-auto">
            {/* Zoom Region Properties */}
            {selectedZoomRegionId && project.zoom.regions.find(r => r.id === selectedZoomRegionId) && (
              <ZoomRegionConfig
                region={project.zoom.regions.find(r => r.id === selectedZoomRegionId)!}
                videoSrc={project.sources.screenVideo}
                canUseAuto={project.sources.cursorData != null}
                onUpdate={(updates) => updateZoomRegion(selectedZoomRegionId, updates)}
                onDelete={() => {
                  deleteZoomRegion(selectedZoomRegionId);
                  selectZoomRegion(null);
                }}
                onDone={() => selectZoomRegion(null)}
              />
            )}

            {/* Scene Segment Properties */}
            {selectedSceneSegmentId && (() => {
              const segment = project.scene.segments.find(s => s.id === selectedSceneSegmentId);
              if (!segment) return null;
              return (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => selectSceneSegment(null)}
                        className="h-7 px-2.5 bg-[var(--coral-100)] hover:bg-[var(--coral-200)] text-[var(--coral-400)] text-xs font-medium rounded-md transition-colors"
                      >
                        Done
                      </button>
                      <span className="text-xs text-[var(--ink-subtle)]">Scene segment</span>
                    </div>
                    <button
                      onClick={() => {
                        deleteSceneSegment(selectedSceneSegmentId);
                        selectSceneSegment(null);
                      }}
                      className="h-7 px-2.5 bg-[var(--error-light)] hover:bg-[rgba(239,68,68,0.2)] text-[var(--error)] text-xs rounded-md transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                  <div className="space-y-3 pt-2">
                    <div>
                      <span className="text-xs text-[var(--ink-muted)] block mb-2">Mode</span>
                      <select
                        value={segment.mode}
                        onChange={(e) => updateSceneSegment(selectedSceneSegmentId, { mode: e.target.value as SceneMode })}
                        className="w-full h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
                      >
                        <option value="default">Screen + Webcam</option>
                        <option value="cameraOnly">Camera Only</option>
                        <option value="screenOnly">Screen Only</option>
                      </select>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Mask Segment Properties */}
            {selectedMaskSegmentId && project.mask?.segments.find(s => s.id === selectedMaskSegmentId) && (
              <MaskSegmentConfig
                segment={project.mask.segments.find(s => s.id === selectedMaskSegmentId)!}
                onUpdate={(updates) => updateMaskSegment(selectedMaskSegmentId, updates)}
                onDelete={() => {
                  deleteMaskSegment(selectedMaskSegmentId);
                  selectMaskSegment(null);
                }}
                onDone={() => selectMaskSegment(null)}
              />
            )}

            {/* Text Segment Properties */}
            {selectedTextSegmentId && (() => {
              // Find segment by generated ID (format: text_<start>_<index>)
              const idParts = selectedTextSegmentId.match(/^text_([0-9.]+)_/);
              if (!idParts) return null;
              const targetStart = parseFloat(idParts[1]);
              const segment = project.text?.segments.find(s =>
                Math.abs(s.start - targetStart) < 0.001
              );
              if (!segment) return null;
              return (
                <TextSegmentConfig
                  segment={segment}
                  onUpdate={(updates) => updateTextSegment(selectedTextSegmentId, updates)}
                  onDelete={() => {
                    deleteTextSegment(selectedTextSegmentId);
                    selectTextSegment(null);
                  }}
                  onDone={() => selectTextSegment(null)}
                />
              );
            })()}
          </div>
        )}

        {/* Project Tab */}
        {activeTab === 'project' && (
          <div className="p-4 space-y-4">
            <div>
              <label className="text-[11px] text-[var(--ink-subtle)] uppercase tracking-wide">Project</label>
              <p className="text-sm text-[var(--ink-dark)] mt-1 truncate">
                {project?.name ?? 'No project loaded'}
              </p>
            </div>

            {project && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Resolution</label>
                    <p className="text-xs text-[var(--ink-dark)] font-mono mt-0.5">
                      {project.sources.originalWidth}x{project.sources.originalHeight}
                    </p>
                  </div>
                  <div>
                    <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Frame Rate</label>
                    <p className="text-xs text-[var(--ink-dark)] font-mono mt-0.5">
                      {project.sources.fps} fps
                    </p>
                  </div>
                  <div>
                    <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Duration</label>
                    <p className="text-xs text-[var(--ink-dark)] font-mono mt-0.5">
                      {Math.floor(project.timeline.durationMs / 60000)}:{String(Math.floor((project.timeline.durationMs % 60000) / 1000)).padStart(2, '0')}
                    </p>
                  </div>
                  <div>
                    <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Zoom Regions</label>
                    <p className="text-xs text-[var(--ink-dark)] mt-0.5">
                      {project.zoom.regions.length}
                    </p>
                  </div>
                </div>

                {/* Audio Controls */}
                <div className="space-y-3 pt-2 border-t border-[var(--glass-border)]">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-[var(--ink-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    </svg>
                    <span className="text-[11px] text-[var(--ink-subtle)] uppercase tracking-wide">Audio Controls</span>
                  </div>

                  {/* Mute All Audio */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--ink-muted)]">Mute Audio</span>
                    <button
                      onClick={() => {
                        const allMuted = project.audio.systemMuted && project.audio.microphoneMuted;
                        updateAudioConfig({
                          systemMuted: !allMuted,
                          microphoneMuted: !allMuted
                        });
                      }}
                      className={`relative w-10 h-5 rounded-full transition-colors ${
                        project.audio.systemMuted && project.audio.microphoneMuted
                          ? 'bg-[var(--coral-400)]'
                          : 'bg-[var(--polar-frost)]'
                      }`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                        project.audio.systemMuted && project.audio.microphoneMuted ? 'translate-x-5' : ''
                      }`} />
                    </button>
                  </div>

                  {/* Microphone Volume - only show when separate mic audio exists */}
                  {project.sources.microphoneAudio && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <svg className="w-3.5 h-3.5 text-[var(--ink-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                          </svg>
                          <span className="text-xs text-[var(--ink-muted)]">Microphone</span>
                        </div>
                        <span className="text-xs text-[var(--ink-dark)] font-mono">
                          {project.audio.microphoneMuted ? 'Muted' : `${Math.round(project.audio.microphoneVolume * 100)}%`}
                        </span>
                      </div>
                      <Slider
                        value={[project.audio.microphoneVolume * 100]}
                        onValueChange={(values) => updateAudioConfig({
                          microphoneVolume: values[0] / 100,
                          microphoneMuted: false
                        })}
                        min={0}
                        max={100}
                        step={1}
                      />
                    </div>
                  )}

                  {/* System Audio / Volume - label changes based on whether separate audio exists */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5 text-[var(--ink-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          {project.sources.systemAudio ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                          )}
                        </svg>
                        <span className="text-xs text-[var(--ink-muted)]">
                          {project.sources.systemAudio ? 'System Audio' : 'Volume'}
                        </span>
                      </div>
                      <span className="text-xs text-[var(--ink-dark)] font-mono">
                        {project.audio.systemMuted ? 'Muted' : `${Math.round(project.audio.systemVolume * 100)}%`}
                      </span>
                    </div>
                    <Slider
                      value={[project.audio.systemVolume * 100]}
                      onValueChange={(values) => updateAudioConfig({
                        systemVolume: values[0] / 100,
                        systemMuted: false
                      })}
                      min={0}
                      max={100}
                      step={1}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Cursor Tab */}
        {activeTab === 'cursor' && project?.sources.cursorData && (
          <div className="p-4 space-y-4">
            {/* Show/Hide Toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--ink-muted)]">Show Cursor</span>
              <button
                onClick={() => updateCursorConfig({ visible: !project.cursor.visible })}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  project.cursor.visible ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    project.cursor.visible ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Cursor Type */}
            <div>
              <span className="text-[11px] text-[var(--ink-subtle)] block mb-2">Cursor Type</span>
              <ToggleGroup
                type="single"
                value={project.cursor.cursorType}
                onValueChange={(value) => {
                  if (value) updateCursorConfig({ cursorType: value as 'auto' | 'circle' });
                }}
                className="justify-start"
              >
                <ToggleGroupItem value="auto" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                  Auto
                </ToggleGroupItem>
                <ToggleGroupItem value="circle" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                  Circle
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            {/* Size Slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--ink-muted)]">Size</span>
                <span className="text-xs text-[var(--ink-dark)] font-mono">
                  {Math.round(project.cursor.scale * 100)}%
                </span>
              </div>
              <Slider
                value={[project.cursor.scale * 100]}
                onValueChange={(values) => updateCursorConfig({ scale: values[0] / 100 })}
                min={50}
                max={300}
                step={10}
              />
            </div>

            {/* Hide When Idle */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--ink-muted)]">Hide When Idle</span>
              <button
                onClick={() => updateCursorConfig({ hideWhenIdle: !project.cursor.hideWhenIdle })}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  project.cursor.hideWhenIdle ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    project.cursor.hideWhenIdle ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Idle Timeout (only when hideWhenIdle is enabled) */}
            {project.cursor.hideWhenIdle && (
              <div className="pl-3 border-l border-[var(--glass-border)]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-[var(--ink-subtle)]">Inactivity Delay</span>
                  <span className="text-[11px] text-[var(--ink-muted)] font-mono">
                    {(project.cursor.idleTimeoutMs / 1000).toFixed(1)}s
                  </span>
                </div>
                <Slider
                  value={[project.cursor.idleTimeoutMs]}
                  onValueChange={(values) => updateCursorConfig({ idleTimeoutMs: values[0] })}
                  min={500}
                  max={5000}
                  step={100}
                />
              </div>
            )}

            {/* Smooth Movement */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--ink-muted)]">Smooth Movement</span>
              <button
                onClick={() => updateCursorConfig({ smoothMovement: !project.cursor.smoothMovement })}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  project.cursor.smoothMovement ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    project.cursor.smoothMovement ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Animation Style (only when smoothMovement is enabled) */}
            {project.cursor.smoothMovement && (
              <div className="pl-3 border-l border-[var(--glass-border)] space-y-3">
                <div>
                  <span className="text-[11px] text-[var(--ink-subtle)] block mb-2">Animation Style</span>
                  <ToggleGroup
                    type="single"
                    value={project.cursor.animationStyle}
                    onValueChange={(value) => {
                      if (value) {
                        const style = value as 'slow' | 'mellow' | 'fast' | 'custom';
                        // Apply preset values when selecting a non-custom style
                        const presets: Record<string, { tension: number; mass: number; friction: number }> = {
                          slow: { tension: 65, mass: 1.8, friction: 16 },
                          mellow: { tension: 120, mass: 1.1, friction: 18 },
                          fast: { tension: 200, mass: 0.8, friction: 20 },
                        };
                        if (style !== 'custom' && presets[style]) {
                          updateCursorConfig({ animationStyle: style, ...presets[style] });
                        } else {
                          updateCursorConfig({ animationStyle: style });
                        }
                      }
                    }}
                    className="justify-start flex-wrap gap-1"
                  >
                    <ToggleGroupItem value="slow" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                      Slow
                    </ToggleGroupItem>
                    <ToggleGroupItem value="mellow" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                      Mellow
                    </ToggleGroupItem>
                    <ToggleGroupItem value="fast" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                      Fast
                    </ToggleGroupItem>
                    <ToggleGroupItem value="custom" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                      Custom
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>

                {/* Physics Controls (only when Custom style is selected) */}
                {project.cursor.animationStyle === 'custom' && (
                  <div className="space-y-3 pt-2">
                    {/* Tension */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-[var(--ink-subtle)]">Tension</span>
                        <span className="text-[11px] text-[var(--ink-muted)] font-mono">{Math.round(project.cursor.tension)}</span>
                      </div>
                      <Slider
                        value={[project.cursor.tension]}
                        onValueChange={(values) => updateCursorConfig({ tension: values[0] })}
                        min={1}
                        max={500}
                        step={5}
                      />
                    </div>

                    {/* Mass */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-[var(--ink-subtle)]">Mass</span>
                        <span className="text-[11px] text-[var(--ink-muted)] font-mono">{project.cursor.mass.toFixed(1)}</span>
                      </div>
                      <Slider
                        value={[project.cursor.mass * 10]}
                        onValueChange={(values) => updateCursorConfig({ mass: values[0] / 10 })}
                        min={1}
                        max={100}
                        step={1}
                      />
                    </div>

                    {/* Friction */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-[var(--ink-subtle)]">Friction</span>
                        <span className="text-[11px] text-[var(--ink-muted)] font-mono">{Math.round(project.cursor.friction)}</span>
                      </div>
                      <Slider
                        value={[project.cursor.friction]}
                        onValueChange={(values) => updateCursorConfig({ friction: values[0] })}
                        min={0}
                        max={50}
                        step={1}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Motion Blur */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--ink-muted)]">Motion Blur</span>
                <span className="text-xs text-[var(--ink-dark)] font-mono">
                  {Math.round(project.cursor.motionBlur * 100)}%
                </span>
              </div>
              <Slider
                value={[project.cursor.motionBlur * 100]}
                onValueChange={(values) => updateCursorConfig({ motionBlur: values[0] / 100 })}
                min={0}
                max={100}
                step={5}
              />
            </div>

            {/* Click Highlight Section */}
            <div className="pt-3 border-t border-[var(--glass-border)]">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-[var(--ink-muted)]">Click Highlight</span>
                <button
                  onClick={() => updateCursorConfig({
                    clickHighlight: { ...project.cursor.clickHighlight, enabled: !project.cursor.clickHighlight.enabled }
                  })}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    project.cursor.clickHighlight.enabled ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                      project.cursor.clickHighlight.enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {project.cursor.clickHighlight.enabled && (
                <div className="space-y-3">
                  {/* Highlight Style */}
                  <div>
                    <span className="text-[11px] text-[var(--ink-subtle)] block mb-2">Style</span>
                    <ToggleGroup
                      type="single"
                      value={project.cursor.clickHighlight.style}
                      onValueChange={(value) => {
                        if (value) updateCursorConfig({
                          clickHighlight: { ...project.cursor.clickHighlight, style: value as 'ripple' | 'spotlight' | 'ring' }
                        });
                      }}
                      className="justify-start"
                    >
                      <ToggleGroupItem value="ripple" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                        Ripple
                      </ToggleGroupItem>
                      <ToggleGroupItem value="spotlight" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                        Spotlight
                      </ToggleGroupItem>
                      <ToggleGroupItem value="ring" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                        Ring
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </div>

                  {/* Highlight Color */}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[var(--ink-subtle)]">Color</span>
                    <input
                      type="color"
                      value={project.cursor.clickHighlight.color}
                      onChange={(e) => updateCursorConfig({
                        clickHighlight: { ...project.cursor.clickHighlight, color: e.target.value }
                      })}
                      className="w-8 h-6 rounded border border-[var(--glass-border)] cursor-pointer bg-transparent"
                    />
                  </div>

                  {/* Highlight Radius */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] text-[var(--ink-subtle)]">Radius</span>
                      <span className="text-[11px] text-[var(--ink-muted)] font-mono">{project.cursor.clickHighlight.radius}px</span>
                    </div>
                    <Slider
                      value={[project.cursor.clickHighlight.radius]}
                      onValueChange={(values) => updateCursorConfig({
                        clickHighlight: { ...project.cursor.clickHighlight, radius: values[0] }
                      })}
                      min={10}
                      max={100}
                      step={5}
                    />
                  </div>

                  {/* Highlight Duration */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] text-[var(--ink-subtle)]">Duration</span>
                      <span className="text-[11px] text-[var(--ink-muted)] font-mono">{project.cursor.clickHighlight.durationMs}ms</span>
                    </div>
                    <Slider
                      value={[project.cursor.clickHighlight.durationMs]}
                      onValueChange={(values) => updateCursorConfig({
                        clickHighlight: { ...project.cursor.clickHighlight, durationMs: values[0] }
                      })}
                      min={100}
                      max={1000}
                      step={50}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Webcam Tab */}
        {activeTab === 'webcam' && project?.sources.webcamVideo && (
          <div className="p-4 space-y-4">
            {/* Show/Hide Toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--ink-muted)]">Show Overlay</span>
              <button
                onClick={() => updateWebcamConfig({ enabled: !project.webcam.enabled })}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  project.webcam.enabled ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    project.webcam.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Size Slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--ink-muted)]">Size</span>
                <span className="text-xs text-[var(--ink-dark)] font-mono">
                  {Math.round(project.webcam.size * 100)}%
                </span>
              </div>
              <Slider
                value={[project.webcam.size * 100]}
                onValueChange={(values) => updateWebcamConfig({ size: values[0] / 100 })}
                min={10}
                max={50}
                step={1}
              />
            </div>

            {/* Shape Toggle */}
            <div>
              <span className="text-xs text-[var(--ink-muted)] block mb-2">Shape</span>
              <ToggleGroup
                type="single"
                value={project.webcam.shape}
                onValueChange={(value) => {
                  if (value) updateWebcamConfig({ shape: value as WebcamOverlayShape });
                }}
                className="justify-start"
              >
                <ToggleGroupItem value="circle" aria-label="Circle" className="h-8 w-8 p-0 data-[state=on]:bg-[var(--polar-frost)]">
                  <Circle className="h-4 w-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="roundedRectangle" aria-label="Squircle" className="h-8 w-8 p-0 data-[state=on]:bg-[var(--polar-frost)]">
                  <Square className="h-4 w-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="source" aria-label="Source" className="h-8 w-8 p-0 data-[state=on]:bg-[var(--polar-frost)]">
                  <Monitor className="h-4 w-4" />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            {/* Rounding (for roundedRectangle and source shapes) */}
            {(project.webcam.shape === 'roundedRectangle' || project.webcam.shape === 'source') && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-[var(--ink-muted)]">Rounding</span>
                  <span className="text-xs text-[var(--ink-subtle)]">{Math.round(project.webcam.rounding)}%</span>
                </div>
                <Slider
                  value={[project.webcam.rounding]}
                  onValueChange={(values) => updateWebcamConfig({ rounding: values[0] })}
                  min={0}
                  max={100}
                  step={1}
                  className="w-full"
                />
              </div>
            )}

            {/* Shadow */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--ink-muted)]">Shadow</span>
                <span className="text-xs text-[var(--ink-subtle)]">{Math.round(project.webcam.shadow)}%</span>
              </div>
              <Slider
                value={[project.webcam.shadow]}
                onValueChange={(values) => updateWebcamConfig({ shadow: values[0] })}
                min={0}
                max={100}
                step={1}
                className="w-full"
              />
            </div>

            {/* Position Grid */}
            <div>
              <span className="text-xs text-[var(--ink-muted)] block mb-2">Position</span>
              <PositionGrid
                position={project.webcam.position}
                customX={project.webcam.customX}
                customY={project.webcam.customY}
                onChange={(pos, x, y) => updateWebcamConfig({ position: pos, customX: x, customY: y })}
              />
            </div>

            {/* Segments count */}
            <div className="pt-3 border-t border-[var(--glass-border)]">
              <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Visibility Segments</label>
              <p className="text-xs text-[var(--ink-dark)] mt-0.5">
                {project.webcam.visibilitySegments.length} segment{project.webcam.visibilitySegments.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        )}

        {/* Background/Style Tab */}
        {activeTab === 'background' && project && (
          <div className="p-4">
            <BackgroundSettings
              background={project.export.background}
              onUpdate={(updates) => updateExportConfig({
                background: { ...project.export.background, ...updates }
              })}
            />
          </div>
        )}

        {/* Export Tab */}
        {activeTab === 'export' && project && (
          <div className="p-4 space-y-4">
            {/* Export Preset */}
            <div>
              <span className="text-xs text-[var(--ink-muted)] block mb-2">Preset</span>
              <select
                value={project.export.preset}
                onChange={(e) => updateExportConfig({ preset: e.target.value as ExportPreset })}
                className="w-full h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
              >
                <option value="draft">Draft (720p, 15fps)</option>
                <option value="standard">Standard (1080p, 30fps)</option>
                <option value="highQuality">High Quality (1080p, 60fps)</option>
                <option value="maximum">Maximum (Source)</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            {/* Aspect Ratio */}
            <div>
              <span className="text-xs text-[var(--ink-muted)] block mb-2">Aspect Ratio</span>
              <select
                value={project.export.aspectRatio}
                onChange={(e) => updateExportConfig({ aspectRatio: e.target.value as AspectRatio })}
                className="w-full h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
              >
                <option value="auto">Auto (Source)</option>
                <option value="landscape16x9">16:9 Landscape</option>
                <option value="portrait9x16">9:16 Portrait</option>
                <option value="square1x1">1:1 Square</option>
                <option value="standard4x3">4:3 Standard</option>
              </select>
            </div>

            {/* Crop Video */}
            <div className="pt-3 border-t border-[var(--glass-border)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--ink-muted)]">Crop Video</span>
                {project.export.crop?.enabled && (
                  <span className="text-[10px] text-[var(--coral-400)] font-medium">
                    {project.export.crop.width}x{project.export.crop.height}
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenCropDialog}
                className="w-full justify-start gap-2"
              >
                <Crop className="w-4 h-4" />
                {project.export.crop?.enabled ? 'Edit Crop' : 'Add Crop'}
              </Button>
              {project.export.crop?.enabled && (
                <p className="text-[10px] text-[var(--ink-subtle)] mt-1.5">
                  Position: {project.export.crop.x}, {project.export.crop.y}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
