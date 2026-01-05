//! Frame buffer pool for efficient capture.
//!
//! Reuses buffers to avoid per-frame allocations in the hot capture loop.

/// Pre-allocated buffer pool for frame capture to avoid allocations in the hot loop.
///
/// The capture loop needs several buffers per frame:
/// - `frame_buffer`: Working copy for cursor/webcam compositing
/// - `flip_buffer`: Vertically flipped output for encoder
///
/// Note: DXGI's `as_nopadding_buffer` requires a fresh Vec each call, so we can't
/// pool that allocation. But we still save allocations on frame_buffer and flip_buffer.
pub struct FrameBufferPool {
    /// Buffer for compositing operations (cursor, webcam)
    pub frame_buffer: Vec<u8>,
    /// Buffer for vertical flip before encoding
    flip_buffer: Vec<u8>,
    /// Expected frame size in bytes (width * height * 4)
    pub frame_size: usize,
}

impl FrameBufferPool {
    /// Create a new buffer pool pre-sized for the given dimensions.
    pub fn new(width: u32, height: u32) -> Self {
        let frame_size = (width as usize) * (height as usize) * 4;
        Self {
            frame_buffer: vec![0u8; frame_size],
            flip_buffer: vec![0u8; frame_size],
            frame_size,
        }
    }

    /// Flip frame_buffer vertically into flip_buffer and return reference.
    pub fn flip_vertical(&mut self, width: u32, height: u32) -> &[u8] {
        let row_size = (width as usize) * 4;
        let total_size = row_size * (height as usize);

        // Flip from frame_buffer to flip_buffer
        for (i, row) in self.frame_buffer[..total_size]
            .chunks_exact(row_size)
            .enumerate()
        {
            let dest_row = height as usize - 1 - i;
            let dest_start = dest_row * row_size;
            self.flip_buffer[dest_start..dest_start + row_size].copy_from_slice(row);
        }

        &self.flip_buffer[..total_size]
    }
}
