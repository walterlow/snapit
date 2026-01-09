#![cfg(windows)]

use std::mem;
use windows::{
    core::PCWSTR,
    Graphics::Capture::GraphicsCaptureItem,
    Win32::{
        Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT, TRUE},
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
            Gdi::{
                EnumDisplayDevicesW, EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW,
                MonitorFromPoint, MonitorFromWindow, DEVMODEW, DISPLAY_DEVICEW,
                ENUM_CURRENT_SETTINGS, HDC, HMONITOR, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
                MONITOR_DEFAULTTONULL,
            },
        },
        System::{
            Threading::{
                GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            WinRT::Graphics::Capture::IGraphicsCaptureItemInterop,
        },
        UI::{
            HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI},
            WindowsAndMessaging::{
                EnumChildWindows, GetCursorPos, GetDesktopWindow, GetWindowLongPtrW, GetWindowRect,
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
                IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, WS_CHILD, WS_EX_TOOLWINDOW,
            },
        },
    },
};

use crate::bounds::{LogicalSize, PhysicalBounds, PhysicalPosition, PhysicalSize};

#[derive(Clone, Copy)]
pub struct DisplayImpl(pub HMONITOR);

unsafe impl Send for DisplayImpl {}

impl DisplayImpl {
    pub fn primary() -> Self {
        const MONITORINFOF_PRIMARY: u32 = 1u32;

        for display in Self::list() {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

            unsafe {
                if GetMonitorInfoW(display.0, &mut info as *mut _ as *mut _).as_bool()
                    && (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0
                {
                    return display;
                }
            }
        }

        let point = POINT { x: 0, y: 0 };
        let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
        Self(monitor)
    }

    pub fn list() -> Vec<Self> {
        unsafe extern "system" fn monitor_enum_proc(
            hmonitor: HMONITOR,
            _hdc: HDC,
            _lprc_clip: *mut RECT,
            lparam: LPARAM,
        ) -> BOOL {
            let list = unsafe { &mut *(lparam.0 as *mut Vec<DisplayImpl>) };
            list.push(DisplayImpl(hmonitor));
            TRUE
        }

        let mut list = vec![];
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(monitor_enum_proc),
                LPARAM(std::ptr::addr_of_mut!(list) as isize),
            );
        }

        list
    }

    pub fn raw_id(&self) -> u64 {
        self.0 .0 as u64
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        let physical_size = self.physical_size()?;

        let dpi = unsafe {
            let mut dpi_x = 0;
            GetDpiForMonitor(self.0, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut 0).ok()?;
            dpi_x
        };

        let scale = dpi as f64 / 96.0;

        Some(LogicalSize::new(
            physical_size.width() / scale,
            physical_size.height() / scale,
        ))
    }

    pub fn get_containing_cursor() -> Option<Self> {
        let mut point = POINT { x: 0, y: 0 };
        unsafe {
            if GetCursorPos(&mut point).is_err() {
                return None;
            }
        }

        let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONULL) };
        if monitor.0 as usize != 0 {
            Some(Self(monitor))
        } else {
            None
        }
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        unsafe { GetMonitorInfoW(self.0, &mut info as *mut _ as *mut _) }
            .as_bool()
            .then(|| {
                let rect = info.monitorInfo.rcMonitor;
                PhysicalBounds::new(
                    PhysicalPosition::new(rect.left as f64, rect.top as f64),
                    PhysicalSize::new(
                        rect.right as f64 - rect.left as f64,
                        rect.bottom as f64 - rect.top as f64,
                    ),
                )
            })
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(self.physical_bounds()?.size())
    }

    pub fn refresh_rate(&self) -> f64 {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        unsafe {
            if GetMonitorInfoW(self.0, &mut info as *mut _ as *mut _).as_bool() {
                let device_name = info.szDevice;
                let mut devmode = DEVMODEW {
                    dmSize: mem::size_of::<DEVMODEW>() as u16,
                    ..Default::default()
                };

                if EnumDisplaySettingsW(
                    PCWSTR(device_name.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &mut devmode,
                )
                .as_bool()
                {
                    devmode.dmDisplayFrequency as f64
                } else {
                    0.0
                }
            } else {
                0.0
            }
        }
    }

    pub fn name(&self) -> Option<String> {
        unsafe {
            let mut monitor_info = MONITORINFOEXW {
                monitorInfo: windows::Win32::Graphics::Gdi::MONITORINFO {
                    cbSize: mem::size_of::<MONITORINFOEXW>() as u32,
                    rcMonitor: RECT::default(),
                    rcWork: RECT::default(),
                    dwFlags: 0,
                },
                szDevice: [0; 32],
            };

            if GetMonitorInfoW(self.0, &mut monitor_info as *mut _ as *mut _).as_bool() {
                let device_name = PCWSTR::from_raw(monitor_info.szDevice.as_ptr());

                let mut display_device = DISPLAY_DEVICEW {
                    cb: mem::size_of::<DISPLAY_DEVICEW>() as u32,
                    DeviceName: [0; 32],
                    DeviceString: [0; 128],
                    StateFlags: Default::default(),
                    DeviceID: [0; 128],
                    DeviceKey: [0; 128],
                };

                if EnumDisplayDevicesW(device_name, 0, &mut display_device, 0).as_bool() {
                    let device_string = display_device.DeviceString;
                    let len = device_string
                        .iter()
                        .position(|&x| x == 0)
                        .unwrap_or(device_string.len());

                    return Some(String::from_utf16_lossy(&device_string[..len]));
                }
            }
        }

        None
    }

    pub fn try_as_capture_item(&self) -> windows::core::Result<GraphicsCaptureItem> {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        unsafe { interop.CreateForMonitor(self.0) }
    }
}

#[derive(Clone, Copy)]
pub struct WindowImpl(HWND);

impl WindowImpl {
    pub fn list() -> Vec<Self> {
        struct EnumContext {
            list: Vec<WindowImpl>,
            current_process_id: u32,
        }

        unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let context = unsafe { &mut *(lparam.0 as *mut EnumContext) };

            if is_window_valid(hwnd, context.current_process_id) {
                context.list.push(WindowImpl(hwnd));
            }

            TRUE
        }

        let mut context = EnumContext {
            list: vec![],
            current_process_id: unsafe { GetCurrentProcessId() },
        };

        unsafe {
            let _ = EnumChildWindows(
                GetDesktopWindow(),
                Some(enum_windows_proc),
                LPARAM(std::ptr::addr_of_mut!(context) as isize),
            );
        }

        context.list
    }

    pub fn id(&self) -> u64 {
        self.0 .0 as u64
    }

    pub fn owner_name(&self) -> Option<String> {
        unsafe {
            let mut process_id = 0u32;
            GetWindowThreadProcessId(self.0, Some(&mut process_id));

            if process_id == 0 {
                return None;
            }

            let process_handle =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;

            let mut buffer = [0u16; 1024];
            let mut buffer_size = buffer.len() as u32;

            let result = QueryFullProcessImageNameW(
                process_handle,
                PROCESS_NAME_FORMAT::default(),
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut buffer_size,
            );

            let _ = CloseHandle(process_handle);

            if result.is_ok() && buffer_size > 0 {
                let path_str = String::from_utf16_lossy(&buffer[..buffer_size as usize]);
                std::path::Path::new(&path_str)
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
            } else {
                None
            }
        }
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        let mut rect = RECT::default();

        unsafe {
            DwmGetWindowAttribute(
                self.0,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&raw mut rect).cast(),
                size_of::<RECT>() as u32,
            )
            .ok()?;

            const BASE_DPI: f64 = 96.0;
            let dpi = match GetDpiForWindow(self.0) {
                0 => BASE_DPI as u32,
                dpi => dpi,
            } as f64;
            let scale_factor = dpi / BASE_DPI;

            Some(LogicalSize {
                width: (rect.right - rect.left) as f64 / scale_factor,
                height: (rect.bottom - rect.top) as f64 / scale_factor,
            })
        }
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        let mut rect = RECT::default();
        unsafe {
            DwmGetWindowAttribute(
                self.0,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&raw mut rect).cast(),
                size_of::<RECT>() as u32,
            )
            .ok()?;

            Some(PhysicalBounds {
                position: PhysicalPosition {
                    x: rect.left as f64,
                    y: rect.top as f64,
                },
                size: PhysicalSize {
                    width: (rect.right - rect.left) as f64,
                    height: (rect.bottom - rect.top) as f64,
                },
            })
        }
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(self.physical_bounds()?.size())
    }

    pub fn display(&self) -> Option<DisplayImpl> {
        let hwmonitor = unsafe { MonitorFromWindow(self.0, MONITOR_DEFAULTTONULL) };
        if hwmonitor.is_invalid() {
            None
        } else {
            Some(DisplayImpl(hwmonitor))
        }
    }

    pub fn name(&self) -> Option<String> {
        let len = unsafe { GetWindowTextLengthW(self.0) };

        let mut name = vec![0u16; usize::try_from(len).unwrap() + 1];
        if len >= 1 {
            let copied = unsafe { GetWindowTextW(self.0, &mut name) };
            if copied == 0 {
                return Some(String::new());
            }
        }

        String::from_utf16(
            &name
                .as_slice()
                .iter()
                .take_while(|ch| **ch != 0x0000)
                .copied()
                .collect::<Vec<u16>>(),
        )
        .ok()
    }

    pub fn try_as_capture_item(&self) -> windows::core::Result<GraphicsCaptureItem> {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        unsafe { interop.CreateForWindow(self.0) }
    }
}

fn is_window_valid(hwnd: HWND, current_process_id: u32) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }

        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == current_process_id {
            return false;
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok() {
            let styles = GetWindowLongPtrW(hwnd, GWL_STYLE);
            let ex_styles = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

            if (ex_styles & isize::try_from(WS_EX_TOOLWINDOW.0).unwrap()) != 0 {
                return false;
            }
            if (styles & isize::try_from(WS_CHILD.0).unwrap()) != 0 {
                return false;
            }
        } else {
            return false;
        }

        true
    }
}
