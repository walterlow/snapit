use cpal::traits::{DeviceTrait, HostTrait};
use wasapi::{DeviceEnumerator, Direction, initialize_mta};

fn main() {
    println!("=== Audio Input Devices (cpal) ===\n");
    
    let host = cpal::default_host();
    if let Ok(devices) = host.input_devices() {
        for (i, device) in devices.enumerate() {
            println!("Device {}:", i);
            if let Ok(name) = device.name() {
                println!("  cpal name: {}", name);
            }
            println!();
        }
    }
    
    println!("\n=== Audio Input Devices (wasapi) ===\n");
    
    let _ = initialize_mta();
    
    let enumerator = DeviceEnumerator::new().expect("Failed to create enumerator");
    let collection = enumerator.get_device_collection(&Direction::Capture).expect("Failed to get collection");
    
    for (i, device_result) in collection.into_iter().enumerate() {
        if let Ok(device) = device_result {
            println!("Device {}:", i);
            if let Ok(name) = device.get_friendlyname() {
                println!("  wasapi friendlyname: {}", name);
            }
            println!();
        }
    }
}
