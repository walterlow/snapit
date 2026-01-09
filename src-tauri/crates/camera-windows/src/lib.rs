//! Windows camera capture using Media Foundation
//!
//! Adapted from Cap's camera-windows crate for SnapIt.
//! Provides device enumeration, format negotiation, and frame capture via callbacks.

#![cfg(windows)]
#![allow(non_snake_case)]

use parking_lot::Mutex;
use std::{
    ffi::{OsStr, OsString},
    fmt::{Debug, Display},
    mem::MaybeUninit,
    ops::Deref,
    os::windows::ffi::OsStringExt,
    ptr::null_mut,
    slice::from_raw_parts,
    sync::mpsc::{channel, Receiver, Sender},
    time::Duration,
};
use tracing::{debug, error, info};
use windows::Win32::{
    Foundation::S_FALSE,
    Media::MediaFoundation::*,
    System::{
        Com::{CoCreateInstance, CoInitialize, CLSCTX_INPROC_SERVER},
        Performance::QueryPerformanceCounter,
        WinRT::{RoInitialize, RO_INIT_MULTITHREADED},
    },
};
use windows_core::{implement, ComObjectInner, Interface, GUID, PWSTR};

/// MF version for Win7+ (same as Cap uses)
const MF_VERSION: u32 = 131184;

// ============================================================================
// Constants
// ============================================================================

pub const MF_API_VERSION: u32 = 131184; // Win7+

// Custom format GUIDs not in windows-rs
const MF_VIDEO_FORMAT_L8: GUID = GUID::from_u128(0x00000050_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_L16: GUID = GUID::from_u128(0x00000051_0000_0010_8000_00aa00389b71);
const MEDIASUBTYPE_NV21: GUID = GUID::from_u128(0x3132564e_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_RGB565: GUID = GUID::from_u128(0x00000017_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_P010: GUID = GUID::from_u128(0x30313050_0000_0010_8000_00aa00389b71);

// ============================================================================
// Device Categories
// ============================================================================

/// Category of video capture device
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceCategory {
    /// Physical webcam or built-in camera
    Physical,
    /// Virtual camera (OBS, Snap Camera, etc.)
    Virtual,
    /// Capture card (Elgato, AVerMedia, etc.)
    CaptureCard,
}

impl DeviceCategory {
    pub fn is_virtual(&self) -> bool {
        matches!(self, DeviceCategory::Virtual)
    }

    pub fn is_capture_card(&self) -> bool {
        matches!(self, DeviceCategory::CaptureCard)
    }
}

const VIRTUAL_CAMERA_PATTERNS: &[&str] = &[
    "obs",
    "virtual",
    "snap camera",
    "manycam",
    "xsplit",
    "streamlabs",
    "droidcam",
    "iriun",
    "epoccam",
    "ndi",
    "newtek",
    "camtwist",
    "mmhmm",
    "chromacam",
    "vtuber",
    "prism live",
    "camo",
    "avatarify",
    "facerig",
    "nvidia broadcast",
];

const CAPTURE_CARD_PATTERNS: &[&str] = &[
    "elgato",
    "avermedia",
    "magewell",
    "blackmagic",
    "decklink",
    "intensity",
    "ultrastudio",
    "atomos",
    "hauppauge",
    "startech",
    "j5create",
    "razer ripsaw",
    "pengo",
    "evga xr1",
    "nzxt signal",
    "genki shadowcast",
    "cam link",
    "live gamer",
    "game capture",
];

fn detect_device_category(name: &OsStr, model_id: Option<&str>) -> DeviceCategory {
    let name_lower = name.to_string_lossy().to_lowercase();
    let model_lower = model_id.map(|m| m.to_lowercase());

    let matches_pattern = |patterns: &[&str]| {
        patterns.iter().any(|pattern| {
            name_lower.contains(pattern)
                || model_lower.as_ref().is_some_and(|m| m.contains(pattern))
        })
    };

    if matches_pattern(CAPTURE_CARD_PATTERNS) {
        DeviceCategory::CaptureCard
    } else if matches_pattern(VIRTUAL_CAMERA_PATTERNS) {
        DeviceCategory::Virtual
    } else {
        DeviceCategory::Physical
    }
}

// ============================================================================
// Pixel Formats
// ============================================================================

/// Supported pixel formats for video capture
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    ARGB,
    RGB24,
    RGB32,
    YUV420P,
    NV12,
    NV21,
    YUYV422,
    UYVY422,
    MJPEG,
    YV12,
    BGR24,
    GRAY8,
    GRAY16,
    RGB565,
    P010,
    H264,
}

impl PixelFormat {
    /// Returns true if this format is traditionally stored bottom-up in memory
    pub fn is_traditionally_bottom_up(&self) -> bool {
        matches!(
            self,
            PixelFormat::RGB24
                | PixelFormat::RGB32
                | PixelFormat::BGR24
                | PixelFormat::ARGB
                | PixelFormat::RGB565
        )
    }
}

fn pixel_format_from_guid(subtype: GUID) -> Option<PixelFormat> {
    Some(match subtype {
        t if t == MFVideoFormat_I420 || t == MFVideoFormat_IYUV => PixelFormat::YUV420P,
        t if t == MFVideoFormat_RGB24 => PixelFormat::RGB24,
        t if t == MFVideoFormat_RGB32 => PixelFormat::RGB32,
        t if t == MFVideoFormat_YUY2 => PixelFormat::YUYV422,
        t if t == MFVideoFormat_UYVY => PixelFormat::UYVY422,
        t if t == MFVideoFormat_ARGB32 => PixelFormat::ARGB,
        t if t == MFVideoFormat_NV12 => PixelFormat::NV12,
        t if t == MFVideoFormat_MJPG => PixelFormat::MJPEG,
        t if t == MFVideoFormat_YV12 => PixelFormat::YV12,
        t if t == MF_VIDEO_FORMAT_L8 => PixelFormat::GRAY8,
        t if t == MF_VIDEO_FORMAT_L16 => PixelFormat::GRAY16,
        t if t == MEDIASUBTYPE_NV21 => PixelFormat::NV21,
        t if t == MF_VIDEO_FORMAT_RGB565 => PixelFormat::RGB565,
        t if t == MF_VIDEO_FORMAT_P010 => PixelFormat::P010,
        t if t == MFVideoFormat_H264 => PixelFormat::H264,
        _ => return None,
    })
}

// ============================================================================
// Format Preferences
// ============================================================================

/// Preferences for selecting a video format from available options
#[derive(Debug, Clone)]
pub struct FormatPreference {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
    pub format_priority: Vec<PixelFormat>,
}

impl FormatPreference {
    pub fn new(width: u32, height: u32, frame_rate: f32) -> Self {
        Self {
            width,
            height,
            frame_rate,
            format_priority: vec![
                PixelFormat::NV12,
                PixelFormat::YUYV422,
                PixelFormat::UYVY422,
                PixelFormat::YUV420P,
                PixelFormat::MJPEG,
                PixelFormat::RGB32,
            ],
        }
    }

    pub fn with_format_priority(mut self, priority: Vec<PixelFormat>) -> Self {
        self.format_priority = priority;
        self
    }

    /// Preference optimized for hardware encoding (prefers NV12)
    pub fn for_hardware_encoding() -> Self {
        Self::new(1920, 1080, 30.0).with_format_priority(vec![
            PixelFormat::NV12,
            PixelFormat::YUYV422,
            PixelFormat::UYVY422,
            PixelFormat::YUV420P,
        ])
    }

    /// Preference for capture cards (60fps, NV12)
    pub fn for_capture_card() -> Self {
        Self::new(1920, 1080, 60.0).with_format_priority(vec![
            PixelFormat::NV12,
            PixelFormat::YUYV422,
            PixelFormat::UYVY422,
            PixelFormat::P010,
        ])
    }
}

impl Default for FormatPreference {
    fn default() -> Self {
        Self::new(1280, 720, 30.0)
    }
}

// ============================================================================
// Video Format
// ============================================================================

/// A video format supported by a capture device
#[derive(Debug, Clone)]
pub struct VideoFormat {
    width: u32,
    height: u32,
    frame_rate: f32,
    pixel_format: PixelFormat,
    is_bottom_up: bool,
    pub(crate) media_type: IMFMediaType,
}

impl VideoFormat {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn frame_rate(&self) -> f32 {
        self.frame_rate
    }

    pub fn pixel_format(&self) -> PixelFormat {
        self.pixel_format
    }

    pub fn is_bottom_up(&self) -> bool {
        self.is_bottom_up
    }

    fn from_media_type(media_type: IMFMediaType) -> Result<Self, VideoFormatError> {
        if unsafe { media_type.GetMajorType()? } != MFMediaType_Video {
            return Err(VideoFormatError::NotVideo);
        }

        let size = unsafe { media_type.GetUINT64(&MF_MT_FRAME_SIZE)? };
        let width = (size >> 32) as u32;
        let height = (size & 0xFFFFFFFF) as u32;

        let frame_rate_ratio = {
            let frame_rate = unsafe { media_type.GetUINT64(&MF_MT_FRAME_RATE)? };
            let numerator = (frame_rate >> 32) as u32;
            let denominator = frame_rate as u32;
            (numerator, denominator)
        };
        let frame_rate = frame_rate_ratio.0 as f32 / frame_rate_ratio.1 as f32;

        let subtype = unsafe { media_type.GetGUID(&MF_MT_SUBTYPE)? };

        let pixel_format =
            pixel_format_from_guid(subtype).ok_or(VideoFormatError::InvalidPixelFormat(subtype))?;

        let is_bottom_up = unsafe { media_type.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
            .map(|stride| (stride as i32) < 0)
            .unwrap_or_else(|_| pixel_format.is_traditionally_bottom_up());

        Ok(Self {
            width,
            height,
            frame_rate,
            pixel_format,
            is_bottom_up,
            media_type,
        })
    }
}

impl Display for VideoFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}x{} {:.1}fps {:?}",
            self.width, self.height, self.frame_rate, self.pixel_format
        )
    }
}

#[derive(thiserror::Error, Debug)]
pub enum VideoFormatError {
    #[error("Provided format is not video")]
    NotVideo,
    #[error("Invalid pixel format '{0:?}'")]
    InvalidPixelFormat(GUID),
    #[error("{0}")]
    Windows(#[from] windows_core::Error),
}

// ============================================================================
// Frame and Buffer
// ============================================================================

/// A captured video frame with its buffer
#[derive(Debug)]
pub struct Frame {
    pub pixel_format: PixelFormat,
    pub width: usize,
    pub height: usize,
    pub is_bottom_up: bool,
    pub timestamp: Duration,
    pub perf_counter: i64,
    pub(crate) buffer: IMFMediaBuffer,
}

impl Frame {
    /// Lock the frame buffer for reading
    pub fn bytes(&self) -> windows_core::Result<FrameBytes<'_>> {
        let mut bytes_ptr = null_mut();
        let mut size = 0;

        unsafe {
            self.buffer.Lock(&mut bytes_ptr, None, Some(&mut size))?;
        }

        Ok(FrameBytes {
            buffer: &self.buffer,
            bytes: unsafe { std::slice::from_raw_parts(bytes_ptr, size as usize) },
        })
    }
}

/// RAII guard for locked frame buffer
pub struct FrameBytes<'a> {
    buffer: &'a IMFMediaBuffer,
    bytes: &'a [u8],
}

impl<'a> Drop for FrameBytes<'a> {
    fn drop(&mut self) {
        let _ = unsafe { self.buffer.Unlock() };
    }
}

impl<'a> Deref for FrameBytes<'a> {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.bytes
    }
}

// ============================================================================
// Device
// ============================================================================

/// A video capture device
#[derive(Clone)]
pub struct VideoDevice {
    id: OsString,
    name: OsString,
    model_id: Option<String>,
    category: DeviceCategory,
    activate: IMFActivate,
    media_source: IMFMediaSource,
}

impl VideoDevice {
    pub fn id(&self) -> &OsStr {
        &self.id
    }

    pub fn name(&self) -> &OsStr {
        &self.name
    }

    pub fn model_id(&self) -> Option<&str> {
        self.model_id.as_deref()
    }

    pub fn category(&self) -> DeviceCategory {
        self.category
    }

    pub fn is_virtual_camera(&self) -> bool {
        self.category.is_virtual()
    }

    pub fn is_capture_card(&self) -> bool {
        self.category.is_capture_card()
    }

    /// Check if this is a high-bandwidth capture card (4K 30fps+)
    pub fn is_high_bandwidth(&self) -> bool {
        if !self.is_capture_card() {
            return false;
        }
        self.formats().iter().any(|f| {
            let pixels = f.width() as u64 * f.height() as u64;
            let fps = f.frame_rate() as u64;
            pixels >= 3840 * 2160 && fps >= 30
        })
    }

    /// Get the maximum resolution supported by this device
    pub fn max_resolution(&self) -> Option<(u32, u32)> {
        self.formats()
            .iter()
            .map(|f| (f.width(), f.height()))
            .max_by_key(|(w, h)| (*w as u64) * (*h as u64))
    }

    /// Get all supported video formats
    pub fn formats(&self) -> Vec<VideoFormat> {
        let reader = match unsafe {
            let mut attributes = None;
            if MFCreateAttributes(&mut attributes, 1).is_err() {
                return Vec::new();
            }
            let attributes = match attributes {
                Some(a) => a,
                None => return Vec::new(),
            };
            // Media source shuts down on drop if this isn't specified
            if attributes
                .SetUINT32(&MF_SOURCE_READER_DISCONNECT_MEDIASOURCE_ON_SHUTDOWN, 1)
                .is_err()
            {
                return Vec::new();
            }
            MFCreateSourceReaderFromMediaSource(&self.media_source, &attributes)
        } {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        let mut formats = Vec::new();
        let mut index = 0u32;

        loop {
            let media_type = match unsafe {
                reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, index)
            } {
                Ok(mt) => mt,
                Err(_) => break,
            };

            if let Ok(format) = VideoFormat::from_media_type(media_type) {
                formats.push(format);
            }

            index += 1;
        }

        formats
    }

    /// Find the best format matching the given preferences
    pub fn find_best_format(&self, preference: &FormatPreference) -> Option<VideoFormat> {
        let formats = self.formats();
        if formats.is_empty() {
            return None;
        }

        let target_pixels = preference.width as u64 * preference.height as u64;

        let score_format = |f: &VideoFormat| {
            let format_priority = preference
                .format_priority
                .iter()
                .position(|&pf| pf == f.pixel_format())
                .map(|pos| 1000 - pos as i32)
                .unwrap_or(0);

            let pixels = f.width() as u64 * f.height() as u64;
            let resolution_score = if pixels == target_pixels {
                500
            } else if pixels > target_pixels {
                400 - ((pixels - target_pixels) / 10000).min(300) as i32
            } else {
                300 - ((target_pixels - pixels) / 10000).min(200) as i32
            };

            let fps_diff = (f.frame_rate() - preference.frame_rate).abs();
            let fps_score = 100 - (fps_diff * 10.0).min(100.0) as i32;

            format_priority + resolution_score + fps_score
        };

        formats.into_iter().max_by_key(score_format)
    }

    /// Find a format with fallback through common formats
    pub fn find_format_with_fallback(&self, preference: &FormatPreference) -> Option<VideoFormat> {
        if let Some(format) = self.find_best_format(preference) {
            return Some(format);
        }

        let fallback_formats = [
            PixelFormat::NV12,
            PixelFormat::YUYV422,
            PixelFormat::UYVY422,
            PixelFormat::MJPEG,
            PixelFormat::RGB32,
            PixelFormat::YUV420P,
        ];

        let formats = self.formats();
        for fallback_pixel_format in fallback_formats {
            if let Some(format) = formats
                .iter()
                .filter(|f| f.pixel_format() == fallback_pixel_format)
                .max_by_key(|f| {
                    let res_score = (f.width() as i32).min(preference.width as i32)
                        + (f.height() as i32).min(preference.height as i32);
                    let fps_score =
                        (100.0 - (f.frame_rate() - preference.frame_rate).abs().min(100.0)) as i32;
                    res_score + fps_score
                })
            {
                return Some(format.clone());
            }
        }

        formats.into_iter().next()
    }

    /// Start capturing frames from this device
    pub fn start_capturing(
        &self,
        format: &VideoFormat,
        callback: impl FnMut(Frame) + Send + 'static,
    ) -> Result<CaptureHandle, StartCapturingError> {
        unsafe {
            // Initialize COM on this thread using MTA (same as Cap)
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_FULL)
                .map_err(|e| StartCapturingError::CreateEngine(e))?;

            let capture_engine_factory: IMFCaptureEngineClassFactory = CoCreateInstance(
                &CLSID_MFCaptureEngineClassFactory,
                None,
                CLSCTX_INPROC_SERVER,
            )
            .map_err(StartCapturingError::CreateEngine)?;

            let engine: IMFCaptureEngine = capture_engine_factory
                .CreateInstance(&CLSID_MFCaptureEngine)
                .map_err(StartCapturingError::CreateEngine)?;

            let (event_tx, event_rx) = channel();
            let video_callback = VideoCallback {
                event_tx,
                sample_callback: Mutex::new(Box::new(callback)),
                format_info: FormatInfo {
                    width: format.width() as usize,
                    height: format.height() as usize,
                    pixel_format: format.pixel_format(),
                    is_bottom_up: format.is_bottom_up(),
                },
            }
            .into_object();

            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 1).map_err(StartCapturingError::ConfigureEngine)?;
            let attributes = attributes.ok_or_else(|| {
                StartCapturingError::ConfigureEngine(windows_core::Error::from_hresult(S_FALSE))
            })?;
            attributes
                .SetUINT32(&MF_CAPTURE_ENGINE_USE_VIDEO_DEVICE_ONLY, 1)
                .map_err(StartCapturingError::ConfigureEngine)?;

            debug!("Initializing Media Foundation capture engine");

            engine
                .Initialize(
                    &video_callback.to_interface::<IMFCaptureEngineOnEventCallback>(),
                    &attributes,
                    None,
                    &self.media_source,
                )
                .map_err(StartCapturingError::InitializeEngine)?;

            wait_for_event(&event_rx, CaptureEngineEventVariant::Initialized).map_err(|_| {
                StartCapturingError::InitializeEngine(windows_core::Error::from_hresult(S_FALSE))
            })?;

            debug!("Media Foundation capture engine initialized");

            let source = engine
                .GetSource()
                .map_err(StartCapturingError::ConfigureSource)?;

            let stream_count = retry_on_invalid_request(|| source.GetDeviceStreamCount())
                .map_err(StartCapturingError::ConfigureSource)?;
            eprintln!("[MF_CAPTURE] Device has {} streams", stream_count);

            let mut maybe_format = None;

            for stream_index in 0..stream_count {
                let Ok(category) =
                    retry_on_invalid_request(|| source.GetDeviceStreamCategory(stream_index))
                else {
                    eprintln!(
                        "[MF_CAPTURE] Stream {}: failed to get category",
                        stream_index
                    );
                    continue;
                };

                let category_name = match category {
                    MF_CAPTURE_ENGINE_STREAM_CATEGORY_VIDEO_PREVIEW => "VIDEO_PREVIEW",
                    MF_CAPTURE_ENGINE_STREAM_CATEGORY_VIDEO_CAPTURE => "VIDEO_CAPTURE",
                    MF_CAPTURE_ENGINE_STREAM_CATEGORY_PHOTO_INDEPENDENT => "PHOTO_INDEPENDENT",
                    MF_CAPTURE_ENGINE_STREAM_CATEGORY_PHOTO_DEPENDENT => "PHOTO_DEPENDENT",
                    MF_CAPTURE_ENGINE_STREAM_CATEGORY_AUDIO => "AUDIO",
                    MF_CAPTURE_ENGINE_STREAM_CATEGORY_UNSUPPORTED => "UNSUPPORTED",
                    MF_CAPTURE_ENGINE_STREAM_CATEGORY_METADATA => "METADATA",
                    _ => "UNKNOWN",
                };
                eprintln!(
                    "[MF_CAPTURE] Stream {}: category = {} ({:?})",
                    stream_index, category_name, category
                );

                if category != MF_CAPTURE_ENGINE_STREAM_CATEGORY_VIDEO_CAPTURE
                    && category != MF_CAPTURE_ENGINE_STREAM_CATEGORY_VIDEO_PREVIEW
                {
                    continue;
                }

                let mut media_type_index = 0;

                loop {
                    let mut media_type = None;
                    if retry_on_invalid_request(|| {
                        source.GetAvailableDeviceMediaType(
                            stream_index,
                            media_type_index,
                            Some(&mut media_type),
                        )
                    })
                    .is_err()
                    {
                        break;
                    }

                    let Some(media_type) = media_type else {
                        continue;
                    };

                    media_type_index += 1;

                    if media_type.IsEqual(&format.media_type) == Ok(0b1111) {
                        eprintln!(
                            "[MF_CAPTURE] Found matching format at stream {} type {}",
                            stream_index, media_type_index
                        );
                        maybe_format = Some((media_type, stream_index));
                    }
                }
            }

            let Some((matched_format, stream_index)) = maybe_format else {
                eprintln!("[MF_CAPTURE] ERROR: No matching format found!");
                return Err(StartCapturingError::ConfigureSource(
                    MF_E_INVALIDREQUEST.into(),
                ));
            };
            eprintln!("[MF_CAPTURE] Using stream {} for capture", stream_index);

            source
                .SetCurrentDeviceMediaType(stream_index, &matched_format)
                .map_err(StartCapturingError::ConfigureSource)?;

            let sink = engine
                .GetSink(MF_CAPTURE_ENGINE_SINK_TYPE_PREVIEW)
                .map_err(StartCapturingError::ConfigureSink)?;
            let preview_sink: IMFCapturePreviewSink =
                sink.cast().map_err(StartCapturingError::ConfigureSink)?;

            eprintln!("[MF_CAPTURE] Removing all streams from preview sink...");
            preview_sink
                .RemoveAllStreams()
                .map_err(StartCapturingError::ConfigureSink)?;

            let mut preview_stream_index = 0u32;
            eprintln!(
                "[MF_CAPTURE] Adding stream {} to preview sink, format: {}x{} {:?}",
                stream_index,
                format.width(),
                format.height(),
                format.pixel_format()
            );
            preview_sink
                .AddStream(
                    stream_index,
                    Some(&matched_format),
                    None,
                    Some(&mut preview_stream_index),
                )
                .map_err(StartCapturingError::ConfigureSink)?;
            eprintln!(
                "[MF_CAPTURE] Stream added, preview_stream_index = {}",
                preview_stream_index
            );

            // Keep sample callback alive by storing it in the handle
            let sample_callback: IMFCaptureEngineOnSampleCallback = video_callback.into_interface();
            eprintln!(
                "[MF_CAPTURE] Setting sample callback on stream {}...",
                preview_stream_index
            );
            preview_sink
                .SetSampleCallback(preview_stream_index, Some(&sample_callback))
                .map_err(StartCapturingError::ConfigureSink)?;
            eprintln!("[MF_CAPTURE] Sample callback set successfully");

            engine
                .StartPreview()
                .map_err(StartCapturingError::StartPreview)?;

            wait_for_event(&event_rx, CaptureEngineEventVariant::PreviewStarted)
                .map_err(|v| StartCapturingError::StartPreview(v.into()))?;

            debug!("Media Foundation capture started");

            Ok(CaptureHandle {
                engine,
                event_rx,
                sample_callback,
            })
        }
    }
}

impl Debug for VideoDevice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoDevice")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("category", &self.category)
            .field("format_count", &self.formats().len())
            .finish()
    }
}

impl Display for VideoDevice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name.to_string_lossy())
    }
}

// ============================================================================
// Capture Handle
// ============================================================================

/// Handle to an active capture session
pub struct CaptureHandle {
    engine: IMFCaptureEngine,
    event_rx: Receiver<CaptureEngineEvent>,
    /// Keep the sample callback alive for the duration of capture
    #[allow(dead_code)]
    sample_callback: IMFCaptureEngineOnSampleCallback,
}

impl CaptureHandle {
    /// Get the event receiver for capture engine events
    pub fn event_rx(&self) -> &Receiver<CaptureEngineEvent> {
        &self.event_rx
    }

    /// Stop capturing and release resources
    pub fn stop_capturing(self) -> windows_core::Result<()> {
        unsafe { self.engine.StopPreview() }
    }
}

// ============================================================================
// Errors
// ============================================================================

#[derive(thiserror::Error, Debug)]
pub enum StartCapturingError {
    #[error("CreateEngine: {0}")]
    CreateEngine(windows_core::Error),
    #[error("ConfigureEngine: {0}")]
    ConfigureEngine(windows_core::Error),
    #[error("InitializeEngine: {0}")]
    InitializeEngine(windows_core::Error),
    #[error("ConfigureSource: {0}")]
    ConfigureSource(windows_core::Error),
    #[error("ConfigureSink: {0}")]
    ConfigureSink(windows_core::Error),
    #[error("StartPreview: {0}")]
    StartPreview(windows_core::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum GetDevicesError {
    #[error("Failed to enumerate devices: {0}")]
    EnumerationFailed(windows_core::Error),
    #[error("COM initialization failed: {0}")]
    ComInitFailed(windows_core::Error),
    #[error("Media Foundation initialization failed: {0}")]
    MfInitFailed(windows_core::Error),
}

// ============================================================================
// Device Enumeration
// ============================================================================

/// Initialize Media Foundation (call once at startup)
pub fn initialize() -> Result<(), GetDevicesError> {
    unsafe { CoInitialize(None) }
        .ok()
        .map_err(GetDevicesError::ComInitFailed)?;
    unsafe { MFStartup(MF_API_VERSION, MFSTARTUP_NOSOCKET) }
        .map_err(GetDevicesError::MfInitFailed)?;
    Ok(())
}

/// Get all available video capture devices
pub fn get_devices() -> Result<Vec<VideoDevice>, GetDevicesError> {
    // Ensure MF is initialized
    let _ = initialize();

    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 1) }
        .map_err(GetDevicesError::EnumerationFailed)?;
    let attributes = attributes.ok_or_else(|| {
        GetDevicesError::EnumerationFailed(windows_core::Error::from_hresult(S_FALSE))
    })?;

    unsafe {
        attributes
            .SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            )
            .map_err(GetDevicesError::EnumerationFailed)?;
    }

    let mut count = 0;
    let mut devices_ptr = MaybeUninit::uninit();

    unsafe {
        MFEnumDeviceSources(&attributes, devices_ptr.as_mut_ptr(), &mut count)
            .map_err(GetDevicesError::EnumerationFailed)?;
    }

    let devices_ptr = unsafe { devices_ptr.assume_init() };

    let mut devices = Vec::new();

    for i in 0..count {
        let Some(activate) = (unsafe { &(*devices_ptr.add(i as usize)) }) else {
            continue;
        };

        let media_source = match unsafe { activate.ActivateObject::<IMFMediaSource>() } {
            Ok(v) => v,
            Err(e) => {
                error!("Failed to activate IMFMediaSource: {}", e);
                continue;
            },
        };

        let name = match get_device_string(activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME) {
            Ok(n) => n,
            Err(_) => continue,
        };

        let id = match get_device_string(
            activate,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
        ) {
            Ok(i) => i,
            Err(_) => continue,
        };

        let model_id = get_device_model_id(&id.to_string_lossy());
        let category = detect_device_category(&name, model_id.as_deref());

        devices.push(VideoDevice {
            id,
            name,
            model_id,
            category,
            activate: activate.clone(),
            media_source,
        });
    }

    Ok(devices)
}

fn get_device_string(activate: &IMFActivate, key: &GUID) -> windows_core::Result<OsString> {
    let mut raw = PWSTR(&mut 0);
    let mut length = 0;
    unsafe {
        activate
            .GetAllocatedString(key, &mut raw, &mut length)
            .map(|_| OsString::from_wide(from_raw_parts(raw.0, length as usize)))
    }
}

fn get_device_model_id(device_id: &str) -> Option<String> {
    let vid_location = device_id.find("vid_")?;
    let pid_location = device_id.find("pid_")?;

    if vid_location + "vid_".len() + 4 > device_id.len()
        || pid_location + "pid_".len() + 4 > device_id.len()
    {
        return None;
    }

    let id_vendor = &device_id[vid_location + 4..vid_location + 8];
    let id_product = &device_id[pid_location + 4..pid_location + 8];

    Some(format!("{id_vendor}:{id_product}"))
}

// ============================================================================
// Capture Engine Internals
// ============================================================================

struct FormatInfo {
    width: usize,
    height: usize,
    pixel_format: PixelFormat,
    is_bottom_up: bool,
}

#[implement(IMFCaptureEngineOnSampleCallback, IMFCaptureEngineOnEventCallback)]
struct VideoCallback {
    event_tx: Sender<CaptureEngineEvent>,
    sample_callback: Mutex<Box<dyn FnMut(Frame) + Send>>,
    format_info: FormatInfo,
}

// Static counter for OnSample calls
static SAMPLE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl IMFCaptureEngineOnSampleCallback_Impl for VideoCallback_Impl {
    fn OnSample(&self, psample: windows_core::Ref<'_, IMFSample>) -> windows_core::Result<()> {
        let count = SAMPLE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if count <= 3 || count % 60 == 0 {
            eprintln!(
                "[MF_CALLBACK] OnSample #{}, sample present: {}",
                count,
                psample.as_ref().is_some()
            );
        }

        let mut perf_counter = 0;
        unsafe { QueryPerformanceCounter(&mut perf_counter)? };

        let Some(sample) = psample.as_ref() else {
            eprintln!("[MF_CALLBACK] OnSample #{}: no sample!", count);
            return Ok(());
        };

        let sample_time = unsafe { sample.GetSampleTime() }?;

        let buffer_count = unsafe { sample.GetBufferCount() }?;
        if count <= 3 {
            eprintln!(
                "[MF_CALLBACK] OnSample #{}: {} buffers, time={}",
                count, buffer_count, sample_time
            );
        }

        for i in 0..buffer_count {
            let Ok(buffer) = (unsafe { sample.GetBufferByIndex(i) }) else {
                eprintln!(
                    "[MF_CALLBACK] OnSample #{}: failed to get buffer {}",
                    count, i
                );
                continue;
            };

            let frame = Frame {
                buffer,
                width: self.format_info.width,
                height: self.format_info.height,
                is_bottom_up: self.format_info.is_bottom_up,
                pixel_format: self.format_info.pixel_format,
                timestamp: Duration::from_micros(sample_time as u64 / 10),
                perf_counter,
            };

            if count <= 3 {
                eprintln!("[MF_CALLBACK] OnSample #{}: calling user callback", count);
            }
            let mut callback = self.sample_callback.lock();
            (callback)(frame);
            if count <= 3 {
                eprintln!("[MF_CALLBACK] OnSample #{}: user callback returned", count);
            }
        }

        Ok(())
    }
}

impl IMFCaptureEngineOnEventCallback_Impl for VideoCallback_Impl {
    fn OnEvent(&self, pevent: windows_core::Ref<'_, IMFMediaEvent>) -> windows_core::Result<()> {
        let Some(event) = pevent.as_ref() else {
            return Ok(());
        };

        // Log the event type
        if let Ok(ext_type) = unsafe { event.GetExtendedType() } {
            eprintln!("[MF_CALLBACK] OnEvent: {:?}", ext_type);
        }

        let _ = self.event_tx.send(CaptureEngineEvent(event.clone()));

        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct CaptureEngineEvent(IMFMediaEvent);

impl CaptureEngineEvent {
    pub fn variant(&self) -> Option<CaptureEngineEventVariant> {
        Some(match unsafe { self.0.GetExtendedType() }.ok()? {
            MF_CAPTURE_ENGINE_ALL_EFFECTS_REMOVED => CaptureEngineEventVariant::AllEffectsRemoved,
            MF_CAPTURE_ENGINE_CAMERA_STREAM_BLOCKED => {
                CaptureEngineEventVariant::CameraStreamBlocked
            },
            MF_CAPTURE_ENGINE_CAMERA_STREAM_UNBLOCKED => {
                CaptureEngineEventVariant::CameraStreamUnblocked
            },
            MF_CAPTURE_ENGINE_EFFECT_ADDED => CaptureEngineEventVariant::EffectAdded,
            MF_CAPTURE_ENGINE_EFFECT_REMOVED => CaptureEngineEventVariant::EffectRemoved,
            MF_CAPTURE_ENGINE_ERROR => CaptureEngineEventVariant::Error,
            MF_CAPTURE_ENGINE_INITIALIZED => CaptureEngineEventVariant::Initialized,
            MF_CAPTURE_ENGINE_PHOTO_TAKEN => CaptureEngineEventVariant::PhotoTaken,
            MF_CAPTURE_ENGINE_PREVIEW_STARTED => CaptureEngineEventVariant::PreviewStarted,
            MF_CAPTURE_ENGINE_PREVIEW_STOPPED => CaptureEngineEventVariant::PreviewStopped,
            MF_CAPTURE_ENGINE_RECORD_STARTED => CaptureEngineEventVariant::RecordStarted,
            MF_CAPTURE_ENGINE_RECORD_STOPPED => CaptureEngineEventVariant::RecordStopped,
            MF_CAPTURE_ENGINE_OUTPUT_MEDIA_TYPE_SET => {
                CaptureEngineEventVariant::OutputMediaTypeSet
            },
            MF_CAPTURE_SINK_PREPARED => CaptureEngineEventVariant::SinkPrepared,
            MF_CAPTURE_SOURCE_CURRENT_DEVICE_MEDIA_TYPE_SET => {
                CaptureEngineEventVariant::SourceCurrentDeviceMediaTypeSet
            },
            _ => return None,
        })
    }
}

#[derive(PartialEq, Eq, Debug, Clone, Copy)]
pub enum CaptureEngineEventVariant {
    Initialized,
    Error,
    PreviewStarted,
    AllEffectsRemoved,
    CameraStreamBlocked,
    CameraStreamUnblocked,
    EffectAdded,
    EffectRemoved,
    PhotoTaken,
    PreviewStopped,
    RecordStarted,
    RecordStopped,
    SinkPrepared,
    SourceCurrentDeviceMediaTypeSet,
    OutputMediaTypeSet,
}

fn wait_for_event(
    rx: &Receiver<CaptureEngineEvent>,
    variant: CaptureEngineEventVariant,
) -> Result<CaptureEngineEvent, windows_core::HRESULT> {
    rx.iter()
        .find_map(|e| match e.variant() {
            Some(v) if v == variant => Some(Ok(e)),
            Some(CaptureEngineEventVariant::Error) => {
                Some(Err(unsafe { e.0.GetStatus() }.unwrap()))
            },
            _ => None,
        })
        .ok_or(windows_core::HRESULT::from_win32(
            MF_E_INVALIDREQUEST.0 as u32,
        ))
        .and_then(|v| v)
}

fn retry_on_invalid_request<T>(
    mut cb: impl FnMut() -> windows_core::Result<T>,
) -> windows_core::Result<T> {
    let mut retry_count = 0;

    const MAX_RETRIES: u32 = 50;
    const INITIAL_DELAY_MS: u64 = 1;
    const MAX_DELAY_MS: u64 = 50;

    let mut current_delay_ms = INITIAL_DELAY_MS;

    loop {
        match cb() {
            Ok(result) => return Ok(result),
            Err(e) if e.code() == MF_E_INVALIDREQUEST => {
                if retry_count >= MAX_RETRIES {
                    return Err(e);
                }
                retry_count += 1;
                std::thread::sleep(Duration::from_millis(current_delay_ms));
                current_delay_ms = (current_delay_ms * 2).min(MAX_DELAY_MS);
            },
            Err(e) => return Err(e),
        }
    }
}
