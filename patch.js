// Patcher imports - need these for ESM compatibility
import { createRequire as __patcherCreateRequire } from 'module';
import { fileURLToPath as __patcherFileURLToPath } from 'url';
import { dirname as __patcherDirname, join as __patcherJoin } from 'path';

// Load modules using require (works better with the app's setup)
const __patcherRequire = __patcherCreateRequire(import.meta.url);
const __patcherHttpsProxyAgent = __patcherRequire('https-proxy-agent').HttpsProxyAgent;
const __patcherExpress = __patcherRequire('express');
const __patcherHttps = __patcherRequire('https');
const __patcherFs = __patcherRequire('fs');
const __patcherOs = __patcherRequire('os');
const __patcherPath = __patcherRequire('path');

// Simple HTTP request helper with redirect support
const __patcherRequest = (method, url, redirectCount = 0) => new Promise((resolve, reject) => {
  const agent = globalProxy ? new __patcherHttpsProxyAgent(globalProxy.startsWith('http') ? globalProxy.replace(/^http:/, 'https:') : 'https://' + globalProxy) : undefined;

  const req = __patcherHttps.request(url, { method, agent }, res => {
    let data = Buffer.alloc(0);
    res.on('data', chunk => data = Buffer.concat([data, chunk]));
    res.on('end', () => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectCount >= 5) return reject(new Error('Too many redirects'));
        return resolve(__patcherRequest(method, res.headers.location, redirectCount + 1));
      }
      resolve({ data, statusCode: res.statusCode, headers: res.headers });
    });
  });
  req.on('error', reject);
  req.end();
});

// Quick check if we can reach the HTTP Toolkit servers
const __patcherHasInternet = () => __patcherRequest('HEAD', 'https://app.httptoolkit.tech')
  .then(r => r.statusCode >= 200 && r.statusCode < 400)
  .catch(() => false);

const __patcherPort = process.env.PATCHER_PORT || 5067;
const __patcherTempPath = __patcherPath.join(__patcherOs.tmpdir(), 'httptoolkit-patch');

// Point the app to our local server instead of the real one
process.env.APP_URL = `http://localhost:${__patcherPort}`;
console.log(`[Patcher] Temp path: ${__patcherTempPath}`);

const __patcherApp = __patcherExpress();
__patcherApp.disable('x-powered-by');

// Catch all requests and proxy them through our server
__patcherApp.all(/(.*)/, async (req, res) => {
  console.log(`[Patcher] ${req.url}`);

  let filePath = __patcherPath.join(__patcherTempPath, new URL(req.url, process.env.APP_URL).pathname === '/' ? 'index.html' : new URL(req.url, process.env.APP_URL).pathname);

  // Some routes need .html extension
  if (['/view', '/intercept', '/settings', '/mock'].includes(new URL(req.url, process.env.APP_URL).pathname)) {
    filePath += '.html';
  }

  // Block service worker - it causes caching headaches
  if (new URL(req.url, process.env.APP_URL).pathname === '/ui-update-worker.js') {
    return res.status(404).send('Not found');
  }

  if (!__patcherFs.existsSync(__patcherTempPath)) {
    __patcherFs.mkdirSync(__patcherTempPath);
  }

  // Offline mode - serve from cache if no internet
  if (!(await __patcherHasInternet())) {
    if (__patcherFs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    return res.status(404).send('No internet and file not cached');
  }

  try {
    // Check if we have a cached copy that's still fresh
    if (__patcherFs.existsSync(filePath)) {
      try {
        const remoteDate = await __patcherRequest('HEAD', `https://app.httptoolkit.tech${req.url}`).then(r => new Date(r.headers['last-modified']));
        if (remoteDate < new Date(__patcherFs.statSync(filePath).mtime)) {
          return res.sendFile(filePath);
        }
      } catch (e) { /* ignore, just redownload */ }
    }

    // Download from the real server
    const remoteFile = await __patcherRequest('GET', `https://app.httptoolkit.tech${req.url}`);
    for (const [key, value] of Object.entries(remoteFile.headers)) res.setHeader(key, value);

    // Create directories if needed
    const mkdirp = dir => {
      if (!__patcherFs.existsSync(dir)) {
        mkdirp(__patcherPath.dirname(dir));
        __patcherFs.mkdirSync(dir);
      }
    };
    mkdirp(__patcherPath.dirname(filePath));

    let data = remoteFile.data;

    // This is where the magic happens - patch main.js to inject pro subscription
    if (new URL(req.url, process.env.APP_URL).pathname === '/main.js') {
      console.log(`[Patcher] Patching main.js...`);
      res.setHeader('Cache-Control', 'no-store');

      data = data.toString();

      // Find the account store class and module names (they're minified so we gotta search for them)
      const accStoreName = data.match(/class ([0-9A-Za-z_]+){constructor\(e\){this\.goToSettings=e/)?.[1];
      const modName = data.match(/([0-9A-Za-z_]+).(getLatestUserData|getLastUserData)/)?.[1];

      if (!accStoreName) console.error(`[Patcher] Couldn't find account store class`);
      else if (!modName) console.error(`[Patcher] Couldn't find user data module`);
      else {
        // Override the user data functions to return our fake pro user
        let patched = data.replace(
          `class ${accStoreName}{`,
          `["getLatestUserData","getLastUserData"].forEach(p=>Object.defineProperty(${modName},p,{value:()=>user}));class ${accStoreName}{`
        );

        if (patched === data) {
          console.error(`[Patcher] Patch failed - couldn't find injection point`);
        } else {
          // Inject our pro user at the top
          patched = `const user=${JSON.stringify({
            email,
            subscription: {
              status: 'active',
              expiry: new Date('6767-06-07').toISOString(),
              sku: 'pro-annual',
            },
            userId: 'patcher',
            banned: false,
            featureFlags: [],
            teamSubscription: null,
          })};user.subscription.expiry=new Date(user.subscription.expiry);` + patched;

          data = patched;
          console.log(`[Patcher] main.js patched successfully!`);
        }
      }
    }

    __patcherFs.writeFileSync(filePath, data);
    res.sendFile(filePath);
  } catch (e) {
    console.error(`[Patcher] Error: ${e.message}`);
    res.status(500).send('Something went wrong');
  }
});

__patcherApp.listen(__patcherPort, () => console.log(`[Patcher] Running on port ${__patcherPort}`));

// Fix CORS so the app can talk to our local server
app.on('ready', () => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    // Block telemetry
    const blocked = ['events.httptoolkit.tech'];
    try {
      const host = new URL(details.url).hostname;
      if (blocked.includes(host) || details.url?.includes('sentry')) {
        return callback({ cancel: true });
      }
    } catch (e) { }

    details.requestHeaders.Origin = 'https://app.httptoolkit.tech';
    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.responseHeaders) {
      details.responseHeaders['Access-Control-Allow-Origin'] = [`http://localhost:${__patcherPort}`];
      delete details.responseHeaders['access-control-allow-origin'];
    }
    callback({ responseHeaders: details.responseHeaders });
  });
});