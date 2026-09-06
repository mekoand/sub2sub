# Run in the Windows desktop user's PowerShell session.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -ne 'AMD64') { throw 'This release supports Windows x64.' }
    $version = if ($env:SUB2SUB_VERSION) { $env:SUB2SUB_VERSION } else { '0.5.2' }
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid SUB2SUB_VERSION.' }
    $base = "https://github.com/mekoand/sub2sub/releases/download/v$version"
    $asset = 'sub2sub-win32-x64.zip'
    $work = Join-Path ([IO.Path]::GetTempPath()) ('sub2sub-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        Write-Host "Downloading sub2sub $version for Windows..."
        Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $work $asset)
        Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS')
        $sums = Get-Content -Raw -LiteralPath (Join-Path $work 'SHA256SUMS')
        $line = @($sums -split "`n" | Where-Object { $_.Trim() -match ('^[a-f0-9]{64}\s+' + [regex]::Escape($asset) + '$') })
        if ($line.Count -ne 1) { throw 'The release checksum is missing or ambiguous.' }
        $expected = ($line[0] -split '\s+')[0]
        if ((Get-FileHash -LiteralPath (Join-Path $work $asset) -Algorithm SHA256).Hash -ne $expected) { throw 'The downloaded release checksum does not match.' }
        $payload = Join-Path $work 'payload'
        Expand-Archive -LiteralPath (Join-Path $work $asset) -DestinationPath $payload
        $installRoot = if ($env:SUB2SUB_INSTALL_DIR) { $env:SUB2SUB_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'sub2sub' }
        & (Join-Path $payload 'runtime\node.exe') (Join-Path $payload 'plugins\sub2sub\scripts\install.mjs') $payload $installRoot
        if ($LASTEXITCODE -ne 0) { throw "sub2sub installation failed (exit $LASTEXITCODE)." }
    } finally { Remove-Item -LiteralPath $work -Recurse -Force }
}
