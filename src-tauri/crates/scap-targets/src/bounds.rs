use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct LogicalBounds {
    pub position: LogicalPosition,
    pub size: LogicalSize,
}

impl LogicalBounds {
    pub fn new(position: LogicalPosition, size: LogicalSize) -> Self {
        Self { position, size }
    }

    pub fn position(&self) -> LogicalPosition {
        self.position
    }

    pub fn size(&self) -> LogicalSize {
        self.size
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct PhysicalBounds {
    pub position: PhysicalPosition,
    pub size: PhysicalSize,
}

impl PhysicalBounds {
    pub fn new(position: PhysicalPosition, size: PhysicalSize) -> Self {
        Self { position, size }
    }

    pub fn position(&self) -> PhysicalPosition {
        self.position
    }

    pub fn size(&self) -> PhysicalSize {
        self.size
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct LogicalSize {
    pub width: f64,
    pub height: f64,
}

impl LogicalSize {
    pub fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }

    pub fn width(&self) -> f64 {
        self.width
    }

    pub fn height(&self) -> f64 {
        self.height
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct PhysicalSize {
    pub width: f64,
    pub height: f64,
}

impl PhysicalSize {
    pub fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }

    pub fn width(&self) -> f64 {
        self.width
    }

    pub fn height(&self) -> f64 {
        self.height
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct LogicalPosition {
    pub x: f64,
    pub y: f64,
}

impl LogicalPosition {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn x(&self) -> f64 {
        self.x
    }

    pub fn y(&self) -> f64 {
        self.y
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct PhysicalPosition {
    pub x: f64,
    pub y: f64,
}

impl PhysicalPosition {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn x(&self) -> f64 {
        self.x
    }

    pub fn y(&self) -> f64 {
        self.y
    }
}
