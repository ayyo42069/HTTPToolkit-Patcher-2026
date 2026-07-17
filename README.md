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

## Notes

- Creates a backup at `app.asar.bak` before patching
- You can set a custom proxy with the `PROXY` environment variable
- Use `--path` to point at a non-default install location; auto-detection covers `Program Files` and the newer `Programs\httptoolkit\HTTP Toolkit` layout on Windows, `/Applications/HTTP Toolkit.app` on macOS, and `/opt`, `/usr/lib`, `/usr/share` locations on Linux
- Works offline after first run (caches UI files locally)

## License

MIT

## Disclaimer

Please buy the original license after using the program.  
https://httptoolkit.com/
