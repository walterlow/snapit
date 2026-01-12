# Build WASM text renderer
# Run: ./build.ps1

# Install wasm-pack if not present
if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
    Write-Host "Installing wasm-pack..."
    cargo install wasm-pack
}

# Build for web target
Write-Host "Building WASM text renderer..."
wasm-pack build --target web --out-dir ../../src/wasm/text-renderer

Write-Host "Build complete! Output in src/wasm/text-renderer/"
