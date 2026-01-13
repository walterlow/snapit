# Local build script for testing release builds
# Usage: .\scripts\local-build.ps1 [-Debug] [-SkipFrontend] [-Run]

param(
    [switch]$Debug,        # Build debug instead of release
    [switch]$SkipFrontend, # Skip frontend build (faster iteration)
    [switch]$Run           # Run the app after building
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "=== SnapIt Local Build ===" -ForegroundColor Cyan

# Step 1: Ensure FFmpeg DLLs are available
$binariesDir = Join-Path $ProjectRoot "src-tauri\binaries"
$dllsExist = (Get-ChildItem -Path $binariesDir -Filter "*.dll" -ErrorAction SilentlyContinue).Count -gt 0

if (-not $dllsExist) {
    Write-Host "`n[1/4] Setting up FFmpeg DLLs..." -ForegroundColor Yellow

    # Check if FFMPEG_DIR is set
    if ($env:FFMPEG_DIR -and (Test-Path "$env:FFMPEG_DIR\bin")) {
        Write-Host "  Using FFMPEG_DIR: $env:FFMPEG_DIR"
        if (!(Test-Path $binariesDir)) { New-Item -ItemType Directory -Path $binariesDir -Force | Out-Null }
        Copy-Item "$env:FFMPEG_DIR\bin\*.dll" -Destination $binariesDir -Force
    } else {
        # Download FFmpeg
        Write-Host "  FFMPEG_DIR not set, downloading FFmpeg 7.1..."
        $ffmpegVersion = "7.1"
        $ffmpegUrl = "https://github.com/GyanD/codexffmpeg/releases/download/$ffmpegVersion/ffmpeg-$ffmpegVersion-full_build-shared.zip"
        $ffmpegZip = Join-Path $env:TEMP "ffmpeg.zip"
        $ffmpegExtract = Join-Path $env:TEMP "ffmpeg-extract"

        if (!(Test-Path $ffmpegZip)) {
            Write-Host "  Downloading..." -NoNewline
            Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip
            Write-Host " Done"
        } else {
            Write-Host "  Using cached download"
        }

        Write-Host "  Extracting..." -NoNewline
        if (Test-Path $ffmpegExtract) { Remove-Item $ffmpegExtract -Recurse -Force }
        Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegExtract -Force
        Write-Host " Done"

        $ffmpegPath = Get-ChildItem -Path $ffmpegExtract -Directory | Select-Object -First 1

        # Set FFMPEG_DIR for this session and future builds
        $env:FFMPEG_DIR = $ffmpegPath.FullName
        Write-Host "  Set FFMPEG_DIR=$env:FFMPEG_DIR"

        # Copy DLLs
        if (!(Test-Path $binariesDir)) { New-Item -ItemType Directory -Path $binariesDir -Force | Out-Null }
        Copy-Item "$($ffmpegPath.FullName)\bin\*.dll" -Destination $binariesDir -Force
    }

    $dlls = Get-ChildItem $binariesDir -Filter "*.dll"
    Write-Host "  Copied $($dlls.Count) DLLs:" -ForegroundColor Green
    $dlls | ForEach-Object { Write-Host "    - $($_.Name)" }
} else {
    Write-Host "`n[1/4] FFmpeg DLLs already present" -ForegroundColor Green
    # Still need FFMPEG_DIR for compilation
    if (-not $env:FFMPEG_DIR) {
        $ffmpegExtract = Join-Path $env:TEMP "ffmpeg-extract"
        $ffmpegPath = Get-ChildItem -Path $ffmpegExtract -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ffmpegPath) {
            $env:FFMPEG_DIR = $ffmpegPath.FullName
            Write-Host "  Set FFMPEG_DIR=$env:FFMPEG_DIR"
        }
    }
}

# Ensure FFMPEG_DIR/bin is in PATH for linking
if ($env:FFMPEG_DIR) {
    $env:PATH = "$env:FFMPEG_DIR\bin;$env:PATH"
}

# Step 2: Install frontend dependencies
Write-Host "`n[2/4] Checking frontend dependencies..." -ForegroundColor Yellow
Push-Location $ProjectRoot
try {
    if (!(Test-Path "node_modules")) {
        Write-Host "  Running bun install..."
        bun install
    } else {
        Write-Host "  node_modules exists" -ForegroundColor Green
    }
} finally {
    Pop-Location
}

# Step 3: Build
Write-Host "`n[3/4] Building Tauri app..." -ForegroundColor Yellow
Push-Location $ProjectRoot
try {
    $buildArgs = @()
    if ($Debug) {
        $buildArgs += "--debug"
        Write-Host "  Mode: Debug"
    } else {
        Write-Host "  Mode: Release"
    }
    if ($SkipFrontend) {
        # Build frontend once, then just rebuild Rust
        Write-Host "  Skipping frontend build"
        $buildArgs += "--no-bundle"
        Push-Location "src-tauri"
        if ($Debug) {
            cargo build
        } else {
            cargo build --release
        }
        Pop-Location
    } else {
        bun run tauri build @buildArgs
    }
} finally {
    Pop-Location
}

# Step 4: Report results
Write-Host "`n[4/4] Build complete!" -ForegroundColor Green

if ($Debug) {
    $exePath = Join-Path $ProjectRoot "src-tauri\target\debug\snapit.exe"
    $bundlePath = $null
} else {
    $exePath = Join-Path $ProjectRoot "src-tauri\target\release\snapit.exe"
    $bundlePath = Join-Path $ProjectRoot "src-tauri\target\release\bundle\nsis"
}

Write-Host "`n  Executable: $exePath"
if ($bundlePath -and (Test-Path $bundlePath)) {
    $installer = Get-ChildItem $bundlePath -Filter "*.exe" | Select-Object -First 1
    if ($installer) {
        Write-Host "  Installer:  $($installer.FullName)"
    }
}

# Run if requested
if ($Run) {
    Write-Host "`nLaunching app..." -ForegroundColor Cyan
    if (Test-Path $exePath) {
        & $exePath
    } else {
        Write-Host "  Executable not found at $exePath" -ForegroundColor Red
    }
}

Write-Host ""
