pub mod bounds;

#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use win::{DisplayImpl, WindowImpl};

use bounds::*;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Clone, Copy)]
pub struct Display(DisplayImpl);

impl Display {
    pub fn list() -> Vec<Self> {
        DisplayImpl::list().into_iter().map(Self).collect()
    }

    pub fn primary() -> Self {
        Self(DisplayImpl::primary())
    }

    pub fn raw_handle(&self) -> &DisplayImpl {
        &self.0
    }

    pub fn id(&self) -> DisplayId {
        DisplayId(self.0.raw_id())
    }

    pub fn from_id(id: &DisplayId) -> Option<Self> {
        Self::list().into_iter().find(|d| &d.id() == id)
    }

    pub fn get_containing_cursor() -> Option<Self> {
        DisplayImpl::get_containing_cursor().map(Self)
    }

    pub fn name(&self) -> Option<String> {
        self.0.name()
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        self.0.physical_size()
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        self.0.logical_size()
    }

    pub fn refresh_rate(&self) -> f64 {
        self.0.refresh_rate()
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        self.0.physical_bounds()
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct DisplayId(u64);

impl DisplayId {
    pub fn raw(&self) -> u64 {
        self.0
    }
}

impl std::fmt::Display for DisplayId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for DisplayId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(Self)
            .map_err(|_| "Invalid display ID".to_string())
    }
}

#[derive(Clone, Copy)]
pub struct Window(WindowImpl);

impl Window {
    pub fn list() -> Vec<Self> {
        WindowImpl::list().into_iter().map(Self).collect()
    }

    pub fn id(&self) -> WindowId {
        WindowId(self.0.id())
    }

    pub fn from_id(id: &WindowId) -> Option<Self> {
        Self::list().into_iter().find(|d| &d.id() == id)
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        self.0.physical_size()
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        self.0.logical_size()
    }

    pub fn owner_name(&self) -> Option<String> {
        self.0.owner_name()
    }

    pub fn raw_handle(&self) -> &WindowImpl {
        &self.0
    }

    pub fn display(&self) -> Option<Display> {
        self.0.display().map(Display)
    }

    pub fn name(&self) -> Option<String> {
        self.0.name()
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        self.0.physical_bounds()
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct WindowId(u64);

impl WindowId {
    pub fn raw(&self) -> u64 {
        self.0
    }
}

impl std::fmt::Display for WindowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for WindowId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(Self)
            .map_err(|_| "Invalid window ID".to_string())
    }
}
