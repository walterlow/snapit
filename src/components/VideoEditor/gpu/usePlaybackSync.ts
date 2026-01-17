/**
 * usePlaybackSync - Playback synchronization for video preview.
 *
 * Extracts playback-related effects from GPUVideoPreview:
 * - Video/audio sync on play/pause
 * - Audio element volume management
 * - Seeking on timeline scrub/click
 */

import { useEffect, useCallback } from 'react';
import { useVideoEditorStore } from '../../../stores/videoEditorStore';
import { usePlaybackControls, initPlaybackEngine, startPlaybackLoop, stopPlaybackLoop } from '../../../hooks/usePlaybackEngine';
import { videoEditorLogger } from '../../../utils/logger';
import type { AudioTrackSettings } from '../../../types';

interface PlaybackSyncOptions {
  /** Main video element ref */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** System audio element ref */
  systemAudioRef: React.RefObject<HTMLAudioElement | null>;
  /** Microphone audio element ref */
  micAudioRef: React.RefObject<HTMLAudioElement | null>;
  /** Video source URL */
  videoSrc: string | null;
  /** System audio source URL */
  systemAudioSrc: string | null;
  /** Microphone audio source URL */
  micAudioSrc: string | null;
  /** Audio configuration from project */
  audioConfig: AudioTrackSettings | undefined;
  /** Timeline duration in ms */
  durationMs: number | undefined;
  /** Whether currently playing */
  isPlaying: boolean;
  /** Preview time in ms (when hovering timeline) */
  previewTimeMs: number | null;
  /** Current playhead time in ms */
  currentTimeMs: number;
  /** Callback when video error occurs */
  onVideoError: (message: string) => void;
}

interface PlaybackSyncResult {
  /** Playback controls */
  controls: ReturnType<typeof usePlaybackControls>;
  /** Handle video click (toggle play/pause) */
  handleVideoClick: () => void;
}

/**
 * Hook for managing playback synchronization between video and audio elements.
 * Extracts complex playback sync logic from GPUVideoPreview.
 */
export function usePlaybackSync(options: PlaybackSyncOptions): PlaybackSyncResult {
  const {
    videoRef,
    systemAudioRef,
    micAudioRef,
    videoSrc,
    systemAudioSrc,
    micAudioSrc,
    audioConfig,
    durationMs,
    isPlaying,
    previewTimeMs,
    currentTimeMs,
    onVideoError,
  } = options;

  const controls = usePlaybackControls();
  const hasSeparateAudio = Boolean(systemAudioSrc || micAudioSrc);

  // Initialize playback engine when project loads
  useEffect(() => {
    if (durationMs) {
      initPlaybackEngine(durationMs);
    }
  }, [durationMs]);

  // Register video element with playback engine
  useEffect(() => {
    if (videoRef.current) {
      controls.setVideoElement(videoRef.current);
      return;
    }
    const id = requestAnimationFrame(() => {
      if (videoRef.current) {
        controls.setVideoElement(videoRef.current);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [controls, videoSrc]);

  // Set duration when project loads
  useEffect(() => {
    if (durationMs) {
      controls.setDuration(durationMs);
    }
  }, [durationMs, controls]);

  // Handle video element events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onEnded = () => {
      controls.pause();
    };

    const onError = (e: Event) => {
      const videoEl = e.target as HTMLVideoElement;
      const error = videoEl.error;
      videoEditorLogger.error('Video error:', error);
      onVideoError(error?.message || 'Failed to load video');
    };

    const onLoadedData = () => {
      onVideoError(''); // Clear any previous error
      // Mute video if we have separate audio files (editor flow)
      if (hasSeparateAudio) {
        video.volume = 0;
        videoEditorLogger.debug(`[Audio] Video loaded, muted (using separate audio files)`);
      } else if (audioConfig) {
        video.volume = audioConfig.systemMuted ? 0 : audioConfig.systemVolume;
        videoEditorLogger.debug(`[Audio] Video loaded, volume set to ${video.volume} (embedded audio)`);
      }
    };

    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoadedData);

    return () => {
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoadedData);
    };
  }, [controls, audioConfig, hasSeparateAudio, onVideoError]);

  // Sync play/pause state from store to video element and RAF loop
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      const playheadTime = useVideoEditorStore.getState().currentTimeMs;
      video.currentTime = playheadTime / 1000;
      if (video.paused) {
        video.play().catch(e => {
          if (e.name === 'AbortError') return;
          videoEditorLogger.error('Play failed:', e);
          controls.pause();
        });
      }
      startPlaybackLoop();
    } else {
      if (!video.paused) {
        video.pause();
      }
      stopPlaybackLoop();
    }
  }, [isPlaying, controls]);

  // Apply volume settings to main video element
  useEffect(() => {
    const video = videoRef.current;
    if (video && audioConfig) {
      if (hasSeparateAudio) {
        video.volume = 0;
        videoEditorLogger.debug(`[Audio] Main video muted (using separate audio files)`);
      } else {
        const newVolume = audioConfig.systemMuted ? 0 : audioConfig.systemVolume;
        video.volume = newVolume;
        videoEditorLogger.debug(`[Audio] Main video volume set to ${newVolume} (embedded audio)`);
      }
    }
  }, [audioConfig, hasSeparateAudio]);

  // Apply volume settings to system audio element
  useEffect(() => {
    const audio = systemAudioRef.current;
    if (audio && audioConfig) {
      const newVolume = audioConfig.systemMuted ? 0 : audioConfig.systemVolume;
      audio.volume = newVolume;
      videoEditorLogger.debug(`[Audio] System audio volume set to ${newVolume}`);
    }
  }, [audioConfig]);

  // Apply volume settings to microphone audio element
  useEffect(() => {
    const audio = micAudioRef.current;
    if (audio && audioConfig) {
      const newVolume = audioConfig.microphoneMuted ? 0 : audioConfig.microphoneVolume;
      audio.volume = newVolume;
      videoEditorLogger.debug(`[Audio] Mic audio volume set to ${newVolume}`);
    }
  }, [audioConfig]);

  // Sync audio playback with video playback
  useEffect(() => {
    const systemAudio = systemAudioRef.current;
    const micAudio = micAudioRef.current;
    const video = videoRef.current;

    if (isPlaying && video) {
      const syncAudio = () => {
        const videoTime = video.currentTime;
        if (systemAudio) {
          systemAudio.currentTime = videoTime;
          systemAudio.play().catch(e => {
            videoEditorLogger.warn('System audio play failed:', e);
          });
        }
        if (micAudio) {
          micAudio.currentTime = videoTime;
          micAudio.play().catch(e => {
            videoEditorLogger.warn('Mic audio play failed:', e);
          });
        }
      };

      if (!video.paused) {
        syncAudio();
      } else {
        video.addEventListener('playing', syncAudio, { once: true });
        return () => video.removeEventListener('playing', syncAudio);
      }
    } else {
      if (systemAudio) systemAudio.pause();
      if (micAudio) micAudio.pause();
    }
  }, [isPlaying]);

  // Seek audio when preview time or current time changes
  useEffect(() => {
    const targetTime = (previewTimeMs !== null ? previewTimeMs : currentTimeMs) / 1000;

    if (isPlaying) {
      const audioTime = systemAudioRef.current?.currentTime ?? micAudioRef.current?.currentTime ?? 0;
      const timeDiff = Math.abs(targetTime - audioTime);
      if (timeDiff < 0.5) return;
    }

    if (systemAudioRef.current) {
      systemAudioRef.current.currentTime = targetTime;
    }
    if (micAudioRef.current) {
      micAudioRef.current.currentTime = targetTime;
    }
  }, [previewTimeMs, currentTimeMs, isPlaying]);

  // Seek video when preview time or current time changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) return;

    const targetTime = previewTimeMs !== null ? previewTimeMs : currentTimeMs;
    video.currentTime = targetTime / 1000;
  }, [previewTimeMs, currentTimeMs, isPlaying]);

  const handleVideoClick = useCallback(() => {
    controls.toggle();
  }, [controls]);

  return {
    controls,
    handleVideoClick,
  };
}
