//! DirectComposition setup for transparent overlay rendering.
//!
//! DirectComposition allows us to create transparent windows that don't cause
//! video blackout issues that occur with traditional WS_EX_LAYERED windows.

// Allow unused fields - kept for resource lifetime management
#![allow(dead_code)]

use windows::core::{Interface, Result};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGISwapChain1};

/// DirectComposition resources for the overlay window.
pub struct CompositorResources {
    /// The composition device
    pub device: IDCompositionDevice,
    /// The composition target bound to the window
    pub target: IDCompositionTarget,
    /// The visual that displays the swap chain content
    pub visual: IDCompositionVisual,
}

/// Create DirectComposition device and visual tree.
///
/// Sets up the composition pipeline:
/// 1. Creates a composition device from the D3D device
/// 2. Creates a target for the window
/// 3. Creates a visual and sets the swap chain as its content
/// 4. Sets the visual as the root of the target
///
/// # Arguments
/// * `d3d_device` - The D3D11 device
/// * `hwnd` - The window handle to composite onto
/// * `swap_chain` - The swap chain to display
pub fn create_compositor(
    d3d_device: &ID3D11Device,
    hwnd: HWND,
    swap_chain: &IDXGISwapChain1,
) -> Result<CompositorResources> {
    unsafe {
        let dxgi_device: IDXGIDevice = d3d_device.cast()?;

        let device: IDCompositionDevice = DCompositionCreateDevice(&dxgi_device)?;
        let target = device.CreateTargetForHwnd(hwnd, true)?;
        let visual = device.CreateVisual()?;

        visual.SetContent(swap_chain)?;
        target.SetRoot(&visual)?;
        device.Commit()?;

        Ok(CompositorResources {
            device,
            target,
            visual,
        })
    }
}
