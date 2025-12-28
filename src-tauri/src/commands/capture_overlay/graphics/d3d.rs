//! Direct3D 11 device and swap chain creation.
//!
//! This module handles the low-level D3D11 setup required for DirectComposition
//! rendering. We use D3D11 as the backend for Direct2D rendering.

use windows::core::Result;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory2, IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, DXGI_CREATE_FACTORY_FLAGS,
    DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_USAGE_RENDER_TARGET_OUTPUT,
};

use windows::core::Interface;

/// Create a D3D11 device for hardware-accelerated rendering.
///
/// The device is created with BGRA support which is required for Direct2D interop.
pub fn create_device() -> Result<ID3D11Device> {
    let mut device: Option<ID3D11Device> = None;

    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;
    }

    device.ok_or_else(|| windows::core::Error::from_win32())
}

/// Create a DXGI swap chain for DirectComposition.
///
/// The swap chain is configured for:
/// - BGRA format (compatible with Direct2D)
/// - Premultiplied alpha (required for transparency)
/// - Flip sequential presentation (efficient for composition)
///
/// # Arguments
/// * `device` - The D3D11 device
/// * `width` - Swap chain width in pixels
/// * `height` - Swap chain height in pixels
pub fn create_swap_chain(device: &ID3D11Device, width: u32, height: u32) -> Result<IDXGISwapChain1> {
    unsafe {
        let dxgi_device: IDXGIDevice = device.cast()?;
        let dxgi_factory: IDXGIFactory2 = CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))?;

        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: windows::Win32::Graphics::Dxgi::DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            Flags: 0,
        };

        dxgi_factory.CreateSwapChainForComposition(&dxgi_device, &desc, None)
    }
}
