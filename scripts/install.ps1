# Install or update the `corpus` CLI on Windows.
#
#   irm https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.ps1 | iex
#
# Downloads corpus-windows-x64.exe from the latest v* GitHub release, checks
# its SHA-256, and installs it as %LOCALAPPDATA%\Programs\corpus\corpus.exe
# (no admin). Adds that folder to your user PATH if it isn't there. Re-run to
# update.
#
# Environment (all optional):
#   CORPUS_VERSION        release tag to install, e.g. v0.6.0 (default: latest)
#   CORPUS_INSTALL_DIR    where to put corpus.exe
#   CORPUS_NO_MODIFY_PATH=1  never change the user PATH
#   CORPUS_DOWNLOAD_BASE  base URL holding the release assets (for mirrors and
#                         testing; overrides CORPUS_VERSION)

# Runs in a script block so `irm | iex` doesn't leak variables or settings
# into the caller's session, and errors stop the install without closing it.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar slows downloads a lot
  $Repo = 'Shunseii/arabic-digitization'
  $Asset = 'corpus-windows-x64.exe'

  # Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { }
    'ARM64' { Write-Host 'Windows on ARM: installing the x64 build, which runs under emulation.' }
    default { throw "corpus installer: unsupported CPU architecture '$arch' (needs 64-bit Windows)." }
  }

  if ($env:CORPUS_DOWNLOAD_BASE) {
    $base = $env:CORPUS_DOWNLOAD_BASE.TrimEnd('/')
  } elseif ($env:CORPUS_VERSION) {
    $tag = if ($env:CORPUS_VERSION.StartsWith('v')) { $env:CORPUS_VERSION } else { "v$($env:CORPUS_VERSION)" }
    $base = "https://github.com/$Repo/releases/download/$tag"
  } else {
    $base = "https://github.com/$Repo/releases/latest/download"
  }

  $dir = if ($env:CORPUS_INSTALL_DIR) { $env:CORPUS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\corpus' }
  $exe = Join-Path $dir 'corpus.exe'
  $tmp = Join-Path $dir ".corpus-download-$PID.exe"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  try {
    Write-Host "Downloading $Asset from $base"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$Asset" -OutFile $tmp
    } catch {
      throw "corpus installer: download failed: $base/$Asset (is there a published v* release with CLI assets?) $($_.Exception.Message)"
    }

    $sums = $null
    try {
      $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/corpus-checksums.txt").Content
      if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    } catch {
      Write-Warning 'No corpus-checksums.txt in the release; skipping checksum verification.'
    }
    if ($sums) {
      $line = $sums -split "`r?`n" | Where-Object { $_ -match "\s\*?$([regex]::Escape($Asset))$" } | Select-Object -First 1
      if (-not $line) { throw "corpus installer: corpus-checksums.txt has no entry for $Asset" }
      $expected = ($line -split '\s+')[0].ToLowerInvariant()
      $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
      if ($expected -ne $actual) {
        throw "corpus installer: checksum mismatch for $Asset (expected $expected, got $actual)"
      }
    }

    $version = & $tmp --version
    if ($LASTEXITCODE -ne 0) { throw 'corpus installer: the downloaded corpus.exe does not run on this machine.' }

    try {
      Move-Item -Force -Path $tmp -Destination $exe
    } catch {
      throw "corpus installer: could not replace $exe. Close any running corpus and try again. $($_.Exception.Message)"
    }
  } finally {
    if (Test-Path $tmp) { Remove-Item -Force $tmp }
  }

  Write-Host "Installed corpus $version to $exe"

  # Read and write the raw registry value: [Environment]::SetEnvironmentVariable
  # would expand entries like %USERPROFILE%\bin and store them as plain text.
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $rawPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = @($rawPath -split ';' | Where-Object { $_ })
    $sameDir = { param($p) [Environment]::ExpandEnvironmentVariables($p).TrimEnd('\') -ieq $dir.TrimEnd('\') }
    if ($entries | Where-Object { & $sameDir $_ }) {
      # Already on the user PATH.
    } elseif ($env:CORPUS_NO_MODIFY_PATH -eq '1') {
      Write-Host "$dir is not on your PATH. Add it yourself to run 'corpus' by name."
    } else {
      $envKey.SetValue('Path', (($entries + $dir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      # Setting any user variable through .NET broadcasts WM_SETTINGCHANGE, so
      # Explorer and new terminals see the new PATH without signing out.
      [Environment]::SetEnvironmentVariable('CORPUS_INSTALLER_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('CORPUS_INSTALLER_REFRESH', $null, 'User')
      Write-Host "Added $dir to your user PATH. Open a new terminal to run 'corpus' by name."
      if (-not (($env:Path -split ';') | Where-Object { & $sameDir $_ })) {
        $env:Path = "$env:Path;$dir"
      }
    }
  } finally {
    $envKey.Close()
  }

  Write-Host ''
  Write-Host "Next: corpus auth status   (then corpus auth login if it's not configured)"
}
