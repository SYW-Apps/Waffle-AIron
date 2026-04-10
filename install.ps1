# waffagent installer for Windows
# Usage: irm https://raw.githubusercontent.com/SYW-Apps/waffagent/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo = "SYW-Apps/waffagent"
$BinName = "waffagent.exe"

# Determine install directory (prefer user-local to avoid needing elevation)
$InstallDir = "$env:LOCALAPPDATA\waffagent\bin"

Write-Host "waffagent installer" -ForegroundColor Cyan
Write-Host ""

# Fetch latest release info from GitHub
Write-Host "Fetching latest release..." -ForegroundColor Gray
try {
    $Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
} catch {
    Write-Error "Failed to fetch release info: $_"
    exit 1
}

$Version = $Release.tag_name
Write-Host "Latest version: $Version" -ForegroundColor White

# Detect architecture
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$VersionNum = $Version.TrimStart('v')
$AssetName = "waffagent-$VersionNum-windows-$Arch.zip"

Write-Host "Downloading $AssetName..." -ForegroundColor Gray

$Asset = $Release.assets | Where-Object { $_.name -eq $AssetName }
if (-not $Asset) {
    Write-Error "Asset '$AssetName' not found in release $Version. Available: $($Release.assets.name -join ', ')"
    exit 1
}

# Download
$TmpZip = Join-Path $env:TEMP $AssetName
try {
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $TmpZip -UseBasicParsing
} catch {
    Write-Error "Download failed: $_"
    exit 1
}

# Extract
$TmpDir = Join-Path $env:TEMP "waffagent-install"
if (Test-Path $TmpDir) { Remove-Item $TmpDir -Recurse -Force }
Expand-Archive -Path $TmpZip -DestinationPath $TmpDir -Force
Remove-Item $TmpZip

# Install binary
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$ExtractedBin = Join-Path $TmpDir $BinName
if (-not (Test-Path $ExtractedBin)) {
    Write-Error "Extracted binary not found at $ExtractedBin"
    exit 1
}

Copy-Item $ExtractedBin (Join-Path $InstallDir $BinName) -Force
Remove-Item $TmpDir -Recurse -Force

Write-Host "Installed to: $InstallDir\$BinName" -ForegroundColor Green

# Add to PATH if not already present
$UserPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
if ($UserPath -notlike "*$InstallDir*") {
    [System.Environment]::SetEnvironmentVariable('PATH', "$UserPath;$InstallDir", 'User')
    Write-Host "Added $InstallDir to your PATH." -ForegroundColor Yellow
    Write-Host "Restart your terminal for the PATH change to take effect." -ForegroundColor Yellow
} else {
    Write-Host "$InstallDir is already in your PATH." -ForegroundColor Gray
}

Write-Host ""
Write-Host "waffagent $Version installed successfully!" -ForegroundColor Cyan
Write-Host "Run: waffagent --help" -ForegroundColor White
