import { spawn } from "node:child_process";

export const shutdownScript = String.raw`
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
`;

export async function closeToolkitBeforePatch(installRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return;
  const launch = options.spawn ?? spawn;
  console.log("Closing HTTP Toolkit instances and servers before patching...");
  await new Promise((resolve, reject) => {
    const child = launch(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(shutdownScript, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: "inherit",
        env: { ...process.env, HTK_PATCH_INSTALL_ROOT: installRoot },
      },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Could not close HTTP Toolkit. No patch files were changed. Run as Administrator if access was denied.",
            ),
          ),
    );
  });
}
