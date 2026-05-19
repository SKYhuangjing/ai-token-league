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
  $args = @(
    "install",
    "--id", $Id,
    "--exact",
    "--accept-source-agreements",
    "--accept-package-agreements",
    "--silent"
  ) + $ExtraArgs
  & winget @args
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

function Install-Rust {
  if ((Test-Command "rustup") -and (Test-Command "cargo")) {
    Write-Step "Rust toolchain already available: $(& rustc --version)"
    & rustup default stable-msvc
    return
  }

  Install-WingetPackage -Id "Rustlang.Rustup" -Name "Rustup"
  Update-PathFromRegistry
  if (-not (Test-Command "rustup")) {
    throw "rustup is still not available on PATH. Open a new PowerShell session and rerun this script."
  }
  & rustup default stable-msvc
}

function Test-VisualStudioBuildTools {
  $vswhereCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
  )
  $vswhere = $vswhereCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $vswhere) {
    return $false
  }

  $installation = & $vswhere `
    -latest `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
  return [bool] $installation
}

function Install-VisualStudioBuildTools {
  if (Test-VisualStudioBuildTools) {
    Write-Step "Visual Studio C++ Build Tools already available"
    return
  }

  Install-WingetPackage `
    -Id "Microsoft.VisualStudio.2022.BuildTools" `
    -Name "Visual Studio 2022 Build Tools" `
    -ExtraArgs @("--override", "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools")

  if (-not (Test-VisualStudioBuildTools)) {
    throw "Visual Studio C++ Build Tools were not detected after install. Reboot if requested, then rerun this script."
  }
}

function Install-NodeDependencies {
  Write-Step "Installing npm dependencies"
  & npm install
  & npm install --no-save --package-lock=false $TauriCliWindowsPackage
}

function Test-Environment {
  Write-Step "Verifying build environment"
  & node -v
  & npm -v
  & rustc --version
  & cargo --version
  if (-not (Test-VisualStudioBuildTools)) {
    throw "Visual Studio C++ Build Tools are missing."
  }
}

Install-Node
Install-GitBash
Install-Rust
Install-VisualStudioBuildTools
Install-NodeDependencies
Test-Environment

Write-Host ""
Write-Host "Windows build environment is ready."
Write-Host "Build with: bash scripts/release.sh --platform win --env env.local --yes"
