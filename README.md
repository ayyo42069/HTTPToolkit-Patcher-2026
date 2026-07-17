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

## MCP / remote control

The patch keeps HTTP Toolkit's MCP (and CLI remote-control) bridge working. To do
this it also patches the bundled node server (`httptoolkit-server/bundle/index.js`,
restored by `node . restore`) to:

- allow the patched UI's local origin through the server's `ALLOWED_ORIGINS` list,
- accept the bridge WebSocket auth (the faked Pro account has no real JWT), and
- treat the session as Pro so Pro-only operations are available over MCP.

Security note: widening `ALLOWED_ORIGINS` relaxes a control that normally stops
other local apps/sites from driving your proxy while the app is open. If you don't
need MCP, run `node . restore` to put the original server back.

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
