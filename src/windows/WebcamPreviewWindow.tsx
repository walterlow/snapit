/**
 * WebcamPreviewWindow - Webcam preview and recording using browser APIs.
 *
 * Uses native browser getUserMedia for smooth preview display.
 * Uses MediaRecorder to capture webcam during recording.
 * Chunks are sent to Rust for file saving.
 * The window is excluded from screen capture (SetWindowDisplayAffinity).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { WebcamSettings, WebcamSize, WebcamShape } from '@/types/generated';

// Preview window size based on webcam size setting
const PREVIEW_SIZES: Record<WebcamSize, number> = {
  small: 120,
  medium: 160,
  large: 200,
};

// Default settings for preview window
const DEFAULT_SETTINGS: WebcamSettings = {
  enabled: true,
  deviceIndex: 0,
  position: { type: 'bottomRight' },
  size: 'medium',
  shape: 'circle',
  mirror: false,
};

const WebcamPreviewWindow: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const pendingChunksRef = useRef<number>(0); // Track pending chunk writes
  const stoppingRef = useRef<boolean>(false); // Track if we're in stopping state
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [settings, setSettings] = useState<WebcamSettings>(DEFAULT_SETTINGS);

  // Listen for settings changes from the toolbar
  useEffect(() => {
    const unlisten = listen<WebcamSettings>('webcam-settings-changed', (event) => {
      console.log('[WebcamPreview] Settings changed:', event.payload);
      setSettings(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Resize window when size setting changes
  useEffect(() => {
    const resizeWindow = async () => {
      try {
        const win = getCurrentWindow();
        const newSize = PREVIEW_SIZES[settings.size];
        await win.setSize(new LogicalSize(newSize, newSize));
      } catch (e) {
        console.error('[WebcamPreview] Failed to resize window:', e);
      }
    };

    resizeWindow();
  }, [settings.size]);

  // Get the device ID for the selected webcam
  const getDeviceId = useCallback(async () => {
    const deviceList = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = deviceList.filter((d) => d.kind === 'videoinput');
    return videoDevices[settings.deviceIndex]?.deviceId;
  }, [settings.deviceIndex]);

  // Start webcam stream
  useEffect(() => {
    let mounted = true;

    const startStream = async () => {
      try {
        // Stop existing stream
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
        }

        const deviceId = await getDeviceId();
        const constraints: MediaStreamConstraints = {
          video: deviceId
            ? { 
                deviceId: { exact: deviceId }, 
                width: { ideal: 1280 }, 
                height: { ideal: 720 },
                frameRate: { ideal: 30, max: 30 }, // Target 30fps for consistent timing
              }
            : { 
                width: { ideal: 1280 }, 
                height: { ideal: 720 },
                frameRate: { ideal: 30, max: 30 },
              },
          audio: false, // No webcam audio - use main mic settings instead
        };

        console.log('[WebcamPreview] Getting user media with constraints:', constraints);
        const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('[WebcamPreview] Got media stream:', mediaStream.id);

        if (mounted) {
          setStream(mediaStream);
          setError(null);
          if (videoRef.current) {
            videoRef.current.srcObject = mediaStream;
          }
        }
      } catch (err) {
        console.error('[WebcamPreview] Failed to get user media:', err);
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to access webcam');
        }
      }
    };

    startStream();

    return () => {
      mounted = false;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [settings.deviceIndex]);

  // Start recording when signal received
  const startRecording = useCallback(async (outputPath: string) => {
    if (!stream || isRecording) {
      console.log('[WebcamPreview] Cannot start recording:', { hasStream: !!stream, isRecording });
      return;
    }

    try {
      console.log('[WebcamPreview] Starting recording to:', outputPath);
      
      // Reset state for new recording
      pendingChunksRef.current = 0;
      stoppingRef.current = false;
      
      // Initialize webcam recording file in Rust
      await invoke('webcam_recording_start', { outputPath });

      // Create MediaRecorder (video only)
      // Try VP9 (best quality), fall back to VP8, then default
      let mimeType = 'video/webm';
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
        mimeType = 'video/webm;codecs=vp9';
      } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
        mimeType = 'video/webm;codecs=vp8';
      }
      console.log('[WebcamPreview] Using mimeType:', mimeType);
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2500000, // 2.5 Mbps
      });

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          pendingChunksRef.current++;
          try {
            const buffer = await event.data.arrayBuffer();
            const chunk = Array.from(new Uint8Array(buffer));
            await invoke('webcam_recording_chunk', { chunk });
            console.log('[WebcamPreview] Wrote chunk:', chunk.length, 'bytes');
          } catch (e) {
            console.error('[WebcamPreview] Failed to send chunk:', e);
          } finally {
            pendingChunksRef.current--;
            // If we're stopping and this was the last chunk, finalize
            if (stoppingRef.current && pendingChunksRef.current === 0) {
              try {
                await invoke('webcam_recording_stop');
                console.log('[WebcamPreview] Recording finalized after last chunk');
              } catch (e) {
                console.error('[WebcamPreview] Failed to finalize recording:', e);
              }
              stoppingRef.current = false;
              setIsRecording(false);
            }
          }
        }
      };

      mediaRecorder.onstop = async () => {
        console.log('[WebcamPreview] MediaRecorder stopped, pending chunks:', pendingChunksRef.current);
        // Mark that we're stopping - the last ondataavailable will finalize
        stoppingRef.current = true;
        // If no pending chunks, finalize immediately
        if (pendingChunksRef.current === 0) {
          try {
            await invoke('webcam_recording_stop');
            console.log('[WebcamPreview] Recording finalized (no pending chunks)');
          } catch (e) {
            console.error('[WebcamPreview] Failed to finalize recording:', e);
          }
          stoppingRef.current = false;
          setIsRecording(false);
        }
        // If there are pending chunks, stoppingRef is true and the last
        // ondataavailable will call webcam_recording_stop when it completes
      };

      mediaRecorder.onerror = (e) => {
        console.error('[WebcamPreview] MediaRecorder error:', e);
        setIsRecording(false);
      };

      // Start recording, send data every 500ms
      mediaRecorder.start(500);
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
      console.log('[WebcamPreview] Recording started');
    } catch (e) {
      console.error('[WebcamPreview] Failed to start recording:', e);
    }
  }, [stream, isRecording]);

  // Stop recording
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      console.log('[WebcamPreview] Stopping recording, requesting final data...');
      // Request any buffered data before stopping
      // This ensures we don't lose the last few frames
      try {
        mediaRecorderRef.current.requestData();
      } catch {
        // requestData might throw if no data buffered, that's OK
      }
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
  }, []);

  // Listen for recording start/stop signals
  useEffect(() => {
    const unlistenStart = listen<{ outputPath: string }>('webcam-recording-start', (event) => {
      console.log('[WebcamPreview] Received recording start event:', event.payload);
      startRecording(event.payload.outputPath);
    });

    const unlistenStop = listen('webcam-recording-stop', () => {
      console.log('[WebcamPreview] Received recording stop event');
      stopRecording();
    });

    return () => {
      unlistenStart.then((fn) => fn()).catch(() => {});
      unlistenStop.then((fn) => fn()).catch(() => {});
    };
  }, [startRecording, stopRecording]);

  // Listen for close event from main window
  useEffect(() => {
    const unlisten = listen('webcam-preview-close', async () => {
      console.log('[WebcamPreview] Received close event');
      // Stop recording if active
      stopRecording();
      // Stop the stream before closing
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      try {
        const win = getCurrentWindow();
        await win.close();
      } catch (e) {
        console.error('[WebcamPreview] Error closing window:', e);
      }
    });

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [stream, stopRecording]);

  // Also close if component unmounts
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [stream]);

  // Enable window dragging
  const handleMouseDown = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      await win.startDragging();
    } catch {
      // Ignore errors
    }
  }, []);

  // Get shape styles
  const getShapeStyles = (shape: WebcamShape): React.CSSProperties => {
    const baseStyles: React.CSSProperties = {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      transform: settings.mirror ? 'scaleX(-1)' : undefined,
    };

    if (shape === 'circle') {
      return {
        ...baseStyles,
        borderRadius: '50%',
      };
    }

    return {
      ...baseStyles,
      borderRadius: '12px',
    };
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        width: '100%',
        height: '100%',
        cursor: 'grab',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: settings.shape === 'circle' ? '50%' : '12px',
          overflow: 'hidden',
          background: 'rgba(0, 0, 0, 0.8)',
          border: isRecording
            ? '3px solid #ef4444'
            : '2px solid rgba(255, 255, 255, 0.2)',
        }}
      >
        {error ? (
          <div
            style={{
              width: '100%',
              height: '100%',
              background: 'rgba(0, 0, 0, 0.8)',
              color: '#ff6b6b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              padding: '8px',
              textAlign: 'center',
            }}
          >
            {error}
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={getShapeStyles(settings.shape)}
          />
        )}
      </div>
    </div>
  );
};

export default WebcamPreviewWindow;
