# HTTP Toolkit Pro Patcher

A simple patcher to enable Pro features in HTTP Toolkit.

**Updated by [kristof.best](https://kristof.best) ([@ayyo42069](https://github.com/ayyo42069))**
**Original by ([@XielQ](https://github.com/XielQs))**

## Requirements

- Node.js 15 or higher
- HTTP Toolkit installed

## Usage

```bash
# Install dependencies
npm install

# Apply the patch
node . patch

# Start HTTP Toolkit
node . start

# Restore original (if needed)
node . restore

# Specify a custom install path (Windows, e.g. Program Files)
node . patch --path "C:\Program Files\HTTP Toolkit"

# Linux / macOS may need elevated permissions to write into the install dir
sudo node . patch
sudo node . patch --path "/opt/HTTP Toolkit"
```

Works on Windows, macOS, and Linux. Install locations are auto-detected on
each platform; use `--path` to point at a non-default location.

## How it works

1. Extracts the app.asar from HTTP Toolkit
2. Injects a local proxy server that intercepts UI requests
3. Patches the subscription data on-the-fly to enable Pro features
4. Flips Electron fuses to bypass ASAR integrity checks
5. Repacks the app

## Verified & Confirmed Versions

| Component | Verified Version | Status |
| :--- | :--- | :--- |
| **HTTP Toolkit Desktop** | **v1.26.0** | Confirmed Working |
| **HTTP Toolkit Server** | **v1.27.4** | Confirmed Working |
| **MCP Interface** | Stdio (`tools/list` 11 tools) | Confirmed Working |
| **Target Interception** | Android 12 (API 31) Emulator (`emulator-5554`) | Confirmed Live Decryption |

## MCP / Remote Control & Live Inspection

The patch preserves HTTP Toolkit's built-in MCP (and CLI remote-control) bridge. It auto-discovers and patches both the installation bundle and user client bundles (`%LOCALAPPDATA%\httptoolkit-server\client\<version>\bundle\index.js` on Windows, and equivalent XDG/macOS paths) to:

- Allow the patched UI's local origin through the server's `ALLOWED_ORIGINS` list.
- Accept the bridge WebSocket authentication (the faked Pro account has no real JWT; patched for v1.27.4+ and legacy versions).
- Force `isPaidUser()` to `true` across the bridge so all Pro operations (`events_list`, `events_get-outline`, `rules_activate`, etc.) are unlocked over MCP.
- Decouple `@oclif/plugin-update` triggers to prevent auto-update check crashes.

### CLI & MCP Usage

```powershell
# 1. Check server & UI readiness
node "$env:LOCALAPPDATA\httptoolkit-server\client\1.27.4\bin\run" ctl status

# 2. Query captured traffic live (no .har export required)
node "$env:LOCALAPPDATA\httptoolkit-server\client\1.27.4\bin\run" ctl events list --limit 10

# 3. Inspect request/response outline
node "$env:LOCALAPPDATA\httptoolkit-server\client\1.27.4\bin\run" ctl events get-outline <event-id>

# 4. Launch stdio MCP server for agent integration
node "$env:LOCALAPPDATA\httptoolkit-server\client\1.27.4\bin\run" mcp
```

## Critical Fixes Applied in 2026 Release

1. **Paddle Pricing Deadlock Fix (`get-prices`):**
   - *Problem:* The UI makes requests to `https://accounts.httptoolkit.tech/api/get-prices`. Previous patcher versions returned the mock user object for all intercepted API calls. Because the pricing response lacked `{ success: true, response: { products: [...] } }`, the UI's `loadPlanPricesUntilSuccess()` loop threw errors and retried infinitely. This stalled `accountStore.initialized`, preventing `eventsStore` from subscribing to traffic events (`ctl events list` remained perpetually empty).
   - *Fix:* Added explicit handling in `patch.js` for `/api/get-prices` returning `{ success: true, response: { products: [...] } }` and fallback vendor bundle neutralization.

2. **Multi-Location Server Bundle Discovery:**
   - *Problem:* HTTP Toolkit on Windows delegates server execution from `Program Files` to `%LOCALAPPDATA%\httptoolkit-server\client\<version>\`. Previous patcher versions only patched `Program Files`, leaving the active server unpatched and causing WebSocket 403 / 1007 rejection on the MCP bridge.
   - *Fix:* `index.js` dynamically scans and patches all active server client bundles in `%LOCALAPPDATA%`, `~/.local/share`, and `~/Library/Application Support`.

3. **Modern v1.27.4+ MCP Bridge Authentication:**
   - *Problem:* The minified JWT verification error handling changed in v1.27.4, bypassing the legacy regex patch.
   - *Fix:* Added regex matching for `e.user=void 0,A.sendAuthResult...`, ensuring dummy tokens are accepted and `isPaidUser` is injected into the authenticated session.

4. **CLI Auto-Updater Decoupling:**
   - *Problem:* `@oclif/plugin-update` checked S3 manifests in the background, emitting `update-requested` on offline/mocked environments which triggered `server.once('exit')` and silently killed Electron after 20-30 seconds.
   - *Fix:* Stubbed `onTriggerUpdate` and suppressed the `update-requested` listener in server bundles and oclif hooks.

5. **Windows Batch / Execution Path Quoting:**
   - *Problem:* When paths contained spaces (e.g. `C:\Program Files\...`), unquoted batch execution failed with `'C:\Program' is not recognized as an internal or external command`. Additionally, invoking `bin/run` directly without `.cmd` or `node` failed on Windows.
   - *Fix:* All batch commands and child process spawns now properly quote `%~dp0` and paths, and run via `node <path>/bin/run`.

## Notes

- Creates a backup at `app.asar.bak` (and `httptoolkit-server/bundle/index.js.bak`) before patching
- You can set a custom proxy with the `PROXY` environment variable
- Use `--path` to point at a non-default install location; auto-detection covers `Program Files` and the newer `Programs\httptoolkit\HTTP Toolkit` layout on Windows, `/Applications/HTTP Toolkit.app` on macOS, and `/opt`, `/usr/lib`, `/usr/share` locations on Linux
- Works offline after first run (caches UI files locally)

## License

MIT

## Disclaimer

Please buy the original license after using the program.  
https://httptoolkit.com/
