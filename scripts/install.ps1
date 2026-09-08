<#
.SYNOPSIS
  Rune — one-line Windows installer.

.DESCRIPTION
  Downloads the prebuilt rune.exe and rune-tools.exe for this machine, VERIFIES
  both against the release's SHA256SUMS, and installs them to
  %LOCALAPPDATA%\Rune\bin, adding that directory to the user PATH.

  Windows binaries have been built by CI for months and nothing could install
  them: web-install.sh hard-exits on anything that is not Darwin or Linux, and
  there was no .ps1. This is that file.

  A note on what you get: Rune has no OS sandbox on Windows. 1st and 2nd gear
  (guided, workspace edits) behave exactly as they do elsewhere; 3rd and 4th
  rune run shell commands WITHOUT the OS-level containment macOS and Linux
  provide. Run under WSL2 if you want the sandbox. The installer says this out
  loud rather than letting you find out later.

.PARAMETER Version
  Release tag to install (default: latest).

.PARAMETER InstallDir
  Where the binaries go (default: %LOCALAPPDATA%\Rune\bin).

.PARAMETER Repo
  GitHub repo hosting the releases (default: ritikkyyadav/Rune).

.PARAMETER SkipTools
  Install rune.exe alone. File, search and shell tools will not work.

.PARAMETER NoPath
  Do not modify the user PATH.

.PARAMETER Uninstall
  Remove the binaries and the PATH entry. Leaves ~/.rune data alone.

.EXAMPLE
  irm https://raw.githubusercontent.com/ritikkyyadav/Rune/main/scripts/install.ps1 | iex

.EXAMPLE
  # With options, the piped form cannot take parameters, so fetch then run:
  irm https://raw.githubusercontent.com/ritikkyyadav/Rune/main/scripts/install.ps1 -OutFile install.ps1
  .\install.ps1 -Version v0.3.0 -NoPath
#>
[CmdletBinding()]
param(
  [string] $Version = $(if ($env:RUNE_VERSION) { $env:RUNE_VERSION } else { 'latest' }),
  [string] $InstallDir = $(if ($env:RUNE_INSTALL_DIR) { $env:RUNE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Rune\bin' }),
  [string] $Repo = $(if ($env:RUNE_REPO) { $env:RUNE_REPO } else { 'ritikkyyadav/Rune' }),
  [switch] $SkipTools,
  [switch] $NoPath,
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($msg) { Write-Host "  $msg" }
function Write-Ok($msg)   { Write-Host "  " -NoNewline; Write-Host "OK" -ForegroundColor Green -NoNewline; Write-Host " $msg" }
function Write-Bad($msg)  { Write-Host "  " -NoNewline; Write-Host "!!" -ForegroundColor Red -NoNewline; Write-Host " $msg" }
function Write-Dim($msg)  { Write-Host "  $msg" -ForegroundColor DarkGray }

# ─── PATH (user scope only — an installer has no business in the machine PATH) ───

function Add-ToUserPath([string] $dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $current) { $current = '' }
  $entries = $current -split ';' | Where-Object { $_ -ne '' }
  if ($entries -contains $dir) {
    Write-Ok "$dir is already on your user PATH"
    return
  }
  Write-Host ''
  Write-Step 'PATH change - this is what will be added to your USER PATH:'
  Write-Host ''
  Write-Host "      + $dir" -ForegroundColor Cyan
  Write-Host ''
  $updated = if ($current.TrimEnd(';') -eq '') { $dir } else { "$($current.TrimEnd(';'));$dir" }
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  # Make it work in THIS session too, so `rune` runs without a new terminal.
  $env:Path = "$env:Path;$dir"
  Write-Ok "Added to your user PATH (open a new terminal for other shells to see it)"
}

function Remove-FromUserPath([string] $dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrEmpty($current)) { return }
  $entries = $current -split ';' | Where-Object { $_ -ne '' -and $_ -ne $dir }
  [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
  Write-Ok "Removed $dir from your user PATH"
}

# ─── Uninstall ───

if ($Uninstall) {
  Write-Host ''
  Write-Step 'Rune uninstaller'
  $removed = $false
  foreach ($name in @('rune.exe', 'rune-tools.exe', 'rune.exe.backup', 'rune-tools.exe.backup')) {
    $p = Join-Path $InstallDir $name
    if (Test-Path $p) {
      Remove-Item -Force $p
      Write-Ok "removed $p"
      $removed = $true
    }
  }
  if (-not $removed) { Write-Dim "nothing to remove in $InstallDir" }
  Remove-FromUserPath $InstallDir
  Write-Host ''
  Write-Step "Your data is untouched: $(Join-Path $env:USERPROFILE '.rune') still holds sessions, config and credentials."
  Write-Step "Remove it yourself if you mean to:  Remove-Item -Recurse -Force `"$(Join-Path $env:USERPROFILE '.rune')`""
  Write-Host ''
  exit 0
}

# ─── Platform ───

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { $env:PROCESSOR_ARCHITECTURE }
}
if ($arch -ne 'x64') {
  Write-Bad "No Windows release build exists for $arch (only x64 is published)."
  Write-Step "x64 binaries run under emulation on ARM64 Windows; install from source for native speed:"
  Write-Step "  https://github.com/$Repo"
  exit 1
}

$asset      = 'rune-windows-x64.exe'
$toolsAsset = 'rune-tools-windows-x64.exe'
$base = if ($Version -eq 'latest') {
  "https://github.com/$Repo/releases/latest/download"
} else {
  "https://github.com/$Repo/releases/download/$Version"
}

Write-Host ''
Write-Step 'Rune installer'
Write-Dim  "platform : windows-$arch"
Write-Dim  "release  : $Version"
Write-Dim  "install  : $InstallDir"
Write-Host ''

# ─── Stage everything before anything is installed ───

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("rune-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

function Get-Asset([string] $name, [string] $dest) {
  try {
    Invoke-WebRequest -Uri "$base/$name" -OutFile $dest -UseBasicParsing
    return $true
  } catch {
    return $false
  }
}

# `SHA256SUMS` is `<hex>  <name>` per line, as sha256sum writes it.
function Get-ExpectedHash([string] $sumsPath, [string] $name) {
  foreach ($line in Get-Content $sumsPath) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
      if ($Matches[2].Trim() -eq $name) { return $Matches[1].ToLower() }
    }
  }
  return $null
}

function Assert-Verified([string] $file, [string] $name, [string] $sumsPath) {
  $want = Get-ExpectedHash $sumsPath $name
  if (-not $want) {
    Write-Bad "SHA256SUMS does not list $name - refusing to install unverified bytes."
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    exit 1
  }
  $got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
  if ($want -ne $got) {
    Write-Bad "Checksum mismatch for $name."
    Write-Step "  expected $want"
    Write-Step "  got      $got"
    Write-Step '  Nothing was installed.'
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Ok "verified $name"
}

try {
  $sumsPath = Join-Path $stage 'SHA256SUMS'
  if (-not (Get-Asset 'SHA256SUMS' $sumsPath)) {
    Write-Bad 'This release publishes no SHA256SUMS. Refusing to install unverified binaries.'
    Write-Step "Releases are at https://github.com/$Repo/releases"
    exit 1
  }

  $cliPath = Join-Path $stage $asset
  if (-not (Get-Asset $asset $cliPath)) {
    Write-Bad "Download failed. Check the release has $asset at:"
    Write-Step "  https://github.com/$Repo/releases"
    exit 1
  }
  Assert-Verified $cliPath $asset $sumsPath

  $toolsPath = $null
  if (-not $SkipTools) {
    $toolsPath = Join-Path $stage $toolsAsset
    if (-not (Get-Asset $toolsAsset $toolsPath)) {
      Write-Bad "$toolsAsset missing from this release - file, search and shell tools would fail."
      Write-Step '  Re-run with -SkipTools to install the CLI alone, or install from source.'
      exit 1
    }
    Assert-Verified $toolsPath $toolsAsset $sumsPath
  }

  # ─── Promote (nothing above touched the install directory) ───
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $cliDest = Join-Path $InstallDir 'rune.exe'
  if (Test-Path $cliDest) { Copy-Item -Force $cliDest "$cliDest.backup" }
  Move-Item -Force $cliPath $cliDest
  Write-Ok "Installed: $cliDest"

  if ($toolsPath) {
    $toolsDest = Join-Path $InstallDir 'rune-tools.exe'
    if (Test-Path $toolsDest) { Copy-Item -Force $toolsDest "$toolsDest.backup" }
    Move-Item -Force $toolsPath $toolsDest
    Write-Ok "Installed: $toolsDest"
  } else {
    Write-Dim 'SkipTools - build it with: cargo build --release -p rune-tools'
  }
} finally {
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}

if (-not $NoPath) {
  Add-ToUserPath $InstallDir
} else {
  Write-Host ''
  Write-Step 'Add Rune to your PATH yourself:'
  Write-Host "      `$env:Path += `";$InstallDir`"" -ForegroundColor Cyan
}

Write-Host ''
Write-Host '  No OS sandbox on Windows.' -ForegroundColor Yellow
Write-Dim  '1st and 2nd gear behave normally. 3rd and 4th gear run shell commands without the'
Write-Dim  'OS-level containment macOS and Linux provide. Run Rune under WSL2 for the sandbox.'
Write-Host ''
Write-Step 'Then run: rune'
Write-Dim  'Free to start: grab a Google AI Studio key and set $env:GOOGLE_API_KEY'
Write-Dim  'Later: `rune upgrade --check` tells you when a newer release exists.'
Write-Host ''
