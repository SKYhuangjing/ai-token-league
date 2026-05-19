$ErrorActionPreference = "Stop"

$TauriCliWindowsPackage = "@tauri-apps/cli-win32-x64-msvc@2.11.1"

function Write-Step {
  param([string] $Message)
  Write-Host ">>> $Message"
}

function Test-Command {
  param([string] $Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Update-PathFromRegistry {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $cargoPath = Join-Path $env:USERPROFILE ".cargo\bin"
  $paths = @($machinePath, $userPath, $cargoPath) | Where-Object { $_ }
  $env:Path = ($paths -join ";")
}

function Get-NodeMajor {
  if (-not (Test-Command "node")) {
    return 0
  }
  $version = (& node -p "Number(process.versions.node.split('.')[0])") 2>$null
  if (-not $version) {
    return 0
  }
  return [int] $version
}

function Install-WingetPackage {
  param(
    [string] $Id,
    [string] $Name,
    [string[]] $ExtraArgs = @()
  )

  if (-not (Test-Command "winget")) {
    throw "winget is required. Install App Installer from Microsoft Store, then rerun this script."
  }

  Write-Step "Installing or updating $Name"
  $wingetArgs = @(
    "install",
    "--id", $Id,
    "--exact",
    "--source", "winget",
    "--accept-source-agreements",
    "--accept-package-agreements",
    "--silent"
  ) + $ExtraArgs
  & winget @wingetArgs
}

function Install-Node {
  if ((Get-NodeMajor) -ge 22) {
    Write-Step "Node.js $(& node -v) already satisfies >= 22"
    return
  }

  Install-WingetPackage -Id "OpenJS.NodeJS.LTS" -Name "Node.js LTS"
  Update-PathFromRegistry
  if ((Get-NodeMajor) -lt 22) {
    throw "Node.js >= 22 is still not available on PATH. Open a new PowerShell session and rerun this script."
  }
}

function Install-GitBash {
  if (Test-Command "bash") {
    Write-Step "Bash already available: $(& bash --version | Select-Object -First 1)"
    return
  }

  Install-WingetPackage -Id "Git.Git" -Name "Git for Windows"
  Update-PathFromRegistry
  if (-not (Test-Command "bash")) {
    throw "bash is still not available on PATH. Open a new PowerShell session and rerun this script."
  }
}

function Install-RustDirect {
  Write-Step "Downloading rustup-init.exe directly"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $rustupUrl = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
  $rustupPath = Join-Path $env:TEMP "rustup-init.exe"
  Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupPath -UseBasicParsing
  Write-Step "Running rustup-init.exe"
  & $rustupPath -y --default-toolchain stable-msvc
}

function Install-Rust {
  if ((Test-Command "rustup") -and (Test-Command "cargo")) {
    Write-Step "Rust toolchain already available: $(& rustc --version)"
    & rustup default stable-msvc
    return
  }

  try {
    Install-WingetPackage -Id "Rustlang.Rustup" -Name "Rustup"
  } catch {
    Write-Step "winget install failed ($($_.Exception.Message)), falling back to direct download"
    Install-RustDirect
  }
  Update-PathFromRegistry
  if (-not (Test-Command "rustup")) {
    throw "rustup is still not available on PATH. Open a new PowerShell session and rerun this script."
  }
  & rustup default stable-msvc
}

# ── MSVC / Windows SDK detection ───────────────────────────────────

function Find-Vswhere {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
  )
  return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Get-MSVCBinDir {
  param([string] $VcToolsPath)
  # Look for the latest MSVC version's Hostx64/x64 linker
  $msvcDir = Join-Path $VcToolsPath "VC\Tools\MSVC"
  if (-not (Test-Path $msvcDir)) { return $null }
  $latest = Get-ChildItem $msvcDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $latest) { return $null }
  $linkerPath = Join-Path $latest.FullName "bin\Hostx64\x64\link.exe"
  if (Test-Path $linkerPath) { return $latest.FullName }
  return $null
}

function Get-WindowsSdkLibDir {
  $sdkDir = "${env:ProgramFiles(x86)}\Windows Kits\10\Lib"
  if (-not (Test-Path $sdkDir)) { return $null }
  $latest = Get-ChildItem $sdkDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $latest) { return $null }
  $ucrtLib = Join-Path $latest.FullName "ucrt\x64\ucrt.lib"
  if (Test-Path $ucrtLib) { return $latest.FullName }
  return $null
}

function Test-VisualStudioBuildTools {
  $vswhere = Find-Vswhere
  if (-not $vswhere) { return $false }

  # Check VC Tools (MSVC compiler/linker)
  $vcPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($vcPath -and (Get-MSVCBinDir $vcPath)) { return $true }

  # Also check if MSVC and Windows SDK exist without vswhere dependency
  $btPath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
  if ((Get-MSVCBinDir $btPath) -and (Get-WindowsSdkLibDir)) { return $true }

  return $false
}

function Test-WindowsSdk {
  return [bool](Get-WindowsSdkLibDir)
}

function Install-VisualStudioBuildTools {
  if (Test-VisualStudioBuildTools) {
    Write-Step "Visual Studio C++ Build Tools and Windows SDK already available"
    return
  }

  Write-Host ""
  Write-Host "  ============================================================"
  Write-Host "  MANUAL STEP REQUIRED: Install Visual Studio Build Tools"
  Write-Host "  ============================================================"
  Write-Host ""
  Write-Host "  winget and silent installers cannot reliably install the"
  Write-Host "  MSVC C++ workload from Git Bash. Please install manually:"
  Write-Host ""
  Write-Host "  1. Download from: https://aka.ms/vs/17/release/vs_BuildTools.exe"
  Write-Host "  2. Run the installer"
  Write-Host "  3. Select workload: 'Desktop development with C++'"
  Write-Host "     (Chinese: '使用 C++ 的桌面开发')"
  Write-Host "  4. On the right panel, ensure these are checked:"
  Write-Host "     - MSVC v143 - VS 2022 C++ x64/x86 build tools"
  Write-Host "     - Windows 10 SDK (or Windows 11 SDK)"
  Write-Host "  5. Click Install (approx 6-7 GB)"
  Write-Host ""

  # Try opening the installer URL
  Start-Process "https://aka.ms/vs/17/release/vs_BuildTools.exe"

  Write-Host "  Press Enter after installation completes (or Ctrl+C to abort)..."
  Read-Host

  if (-not (Test-VisualStudioBuildTools)) {
    Write-Step "WARNING: Visual Studio C++ Build Tools still not detected."
    Write-Host "  The script will continue, but builds may fail."
    Write-Host "  If builds fail with linker errors, install manually as described above."
  }
}

function Test-RebootRequired {
  return (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") -or
         (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") -or
         (Test-Path "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\PendingFileRenameOperations")
}

function Install-NodeDependencies {
  Write-Step "Installing npm dependencies"
  & npm install
  & npm install --no-save --package-lock=false $TauriCliWindowsPackage
}

function Test-Environment {
  Write-Step "Verifying build environment"
  Write-Host "  Node:    $(node -v)"
  Write-Host "  npm:     $(npm -v)"
  Update-PathFromRegistry
  Write-Host "  Rust:    $(rustc --version)"
  Write-Host "  Cargo:   $(cargo --version)"

  $msvcOk = Test-VisualStudioBuildTools
  $sdkOk = Test-WindowsSdk

  if ($msvcOk) {
    $msvcBase = Get-MSVCBinDir "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
    if (-not $msvcBase) {
      $vswhere = Find-Vswhere
      if ($vswhere) {
        $instPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($instPath) { $msvcBase = Get-MSVCBinDir $instPath }
      }
    }
    if ($msvcBase) { Write-Host "  MSVC:    $msvcBase" }
  } else {
    Write-Host "  MSVC:    NOT FOUND" -ForegroundColor Red
  }

  $sdkBase = Get-WindowsSdkLibDir
  if ($sdkBase) {
    Write-Host "  Win SDK: $sdkBase"
  } else {
    Write-Host "  Win SDK: NOT FOUND" -ForegroundColor Red
  }

  return ($msvcOk -and $sdkOk)
}

# ── Main ────────────────────────────────────────────────────────────

Install-Node
Install-GitBash
Install-Rust
Install-VisualStudioBuildTools
Install-NodeDependencies

$envOk = Test-Environment

Write-Host ""
if ($envOk) {
  Write-Host "Windows build environment is ready." -ForegroundColor Green
  Write-Host ""
  Write-Host "Build with:"
  Write-Host "  bash scripts/release.sh --platform win --env env.local --yes"
} else {
  Write-Host "Windows build environment is NOT ready." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Missing components detected above. Install them and rerun this script."
  Write-Host ""
  Write-Host "Common fixes:"
  Write-Host "  - MSVC not found: Install 'Desktop development with C++' in VS Build Tools"
  Write-Host "  - Windows SDK not found: Install 'Windows 10 SDK' in VS Build Tools"
  Write-Host "  - After install: reboot or open a new PowerShell before building"
  exit 1
}
