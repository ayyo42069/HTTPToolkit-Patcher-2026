// Patcher imports - dynamic import works in both ESM and CJS
const __patcherHttpsProxyAgent = (await import('https-proxy-agent')).HttpsProxyAgent;
const __patcherExpress = (await import('express')).default;
const __patcherHttps = (await import('https')).default;
const __patcherFs = (await import('fs')).default;
const __patcherOs = (await import('os')).default;
const __patcherPath = (await import('path')).default;

// The fake pro user we inject everywhere
const __patcherProUser = {
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
};

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

// LAYER 2: Intercept account API calls directly
// Handles any endpoint the account store calls, so even if JS regex fails, app still gets pro user
__patcherApp.all(/^\/__patcher_api\/(.*)/, (req, res) => {
  console.log(`[Patcher] API intercept: ${req.url}`);
  const user = JSON.parse(JSON.stringify(__patcherProUser));
  user.subscription.expiry = new Date(user.subscription.expiry);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.json(user);
});

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

    // LAYER 1: Patch main.js JS directly (with multiple fallback patterns)
    if (new URL(req.url, process.env.APP_URL).pathname === '/main.js') {
      console.log(`[Patcher] Patching main.js...`);
      res.setHeader('Cache-Control', 'no-store');

      data = data.toString();

      // Try multiple regex patterns for different minification versions
      const accStoreName =
        data.match(/class ([0-9A-Za-z_$]+)\s*\{\s*constructor\s*\(\s*e\s*\)\s*\{\s*this\.goToSettings\s*=\s*e/)?.[1] ||
        data.match(/class ([0-9A-Za-z_$]+)[^{]*\{[^}]{0,200}goToSettings/)?.[1];

      const modName =
        data.match(/([0-9A-Za-z_$]+)\.(getLatestUserData|getLastUserData)/)?.[1];

      const userJson = JSON.stringify(__patcherProUser);
      const userInit = `const __pUser=${userJson};__pUser.subscription.expiry=new Date(__pUser.subscription.expiry);`;

      if (!accStoreName) {
        console.error(`[Patcher] Couldn't find account store class - relying on API interception`);
      } else if (!modName) {
        console.error(`[Patcher] Couldn't find user data module - relying on API interception`);
      } else {
        const classPattern = new RegExp(`class ${accStoreName}\\s*\\{`);
        let patched = data.replace(
          classPattern,
          `["getLatestUserData","getLastUserData"].forEach(p=>Object.defineProperty(${modName},p,{value:()=>__pUser}));class ${accStoreName}{`
        );

        if (patched === data) {
          console.error(`[Patcher] JS inject failed - relying on API interception`);
        } else {
          data = userInit + patched;
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

// Fix CORS and intercept account API at the Electron session level
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

  // LAYER 2: Redirect any account/auth API calls to our fake endpoint
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['https://api.httptoolkit.tech/*', 'https://accounts.httptoolkit.tech/*'] },
    (details, callback) => {
      try {
        const url = new URL(details.url);
        const redirectURL = `http://localhost:${__patcherPort}/__patcher_api${url.pathname}${url.search}`;
        console.log(`[Patcher] Redirecting API: ${details.url} -> ${redirectURL}`);
        callback({ redirectURL });
      } catch (e) {
        callback({});
      }
    }
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.responseHeaders) {
      details.responseHeaders['Access-Control-Allow-Origin'] = [`http://localhost:${__patcherPort}`];
      delete details.responseHeaders['access-control-allow-origin'];
    }
    callback({ responseHeaders: details.responseHeaders });
  });
});