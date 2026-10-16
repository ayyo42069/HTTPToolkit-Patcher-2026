// Windows only: closing HTTP Toolkit before patching, since it locks the files we rewrite
import { spawn, spawnSync } from 'child_process'

const shutdownScript = String.raw`
$ErrorActionPreference = 'Stop'
$installRoot = $env:HTK_PATCH_INSTALL_ROOT
$serverRoot = Join-Path $env:LOCALAPPDATA 'httptoolkit-server'
function Get-ToolkitProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq 'HTTP Toolkit.exe' -or
        ($_.Name -ieq 'node.exe' -and $_.ExecutablePath -and
            ($_.ExecutablePath.StartsWith($serverRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
             $_.ExecutablePath.StartsWith($installRoot + '\resources\httptoolkit-server\', [StringComparison]::OrdinalIgnoreCase)) -and
            $_.CommandLine -match '(?i)\bstart\b.*--server-port')
    })
}
$targets = Get-ToolkitProcesses
foreach ($target in $targets) {
    $process = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
}
$deadline = [DateTime]::UtcNow.AddSeconds(3)
while ((Get-ToolkitProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
foreach ($target in (Get-ToolkitProcesses)) {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    $remaining = Get-ToolkitProcesses
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
if ($remaining.Count -gt 0) { throw 'HTTP Toolkit is still running. Close it or run the patcher as Administrator.' }
Write-Output 'Verified: all HTTP Toolkit instances and server processes have exited.'
`

// If tasklist itself fails we can't tell, so report "running" and let the user decide
export const isToolkitRunning = () => {
  const { status, stdout } = spawnSync('tasklist', ['/FI', 'IMAGENAME eq HTTP Toolkit.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  return status !== 0 || stdout.includes('"HTTP Toolkit.exe"')
}

export const closeToolkitBeforePatch = installRoot => new Promise((resolve, reject) => {
  console.log('Closing HTTP Toolkit instances and servers before patching...')
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(shutdownScript, 'utf16le').toString('base64')
  ], {
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, HTK_PATCH_INSTALL_ROOT: installRoot }
  })
  child.once('error', reject)
  child.once('close', code => code === 0
    ? resolve(undefined)
    : reject(new Error('Could not close HTTP Toolkit, so nothing was changed. Run as Administrator if access was denied.')))
})
