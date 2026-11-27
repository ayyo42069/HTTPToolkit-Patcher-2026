// --- Patcher Imports ---
// Written for ESM. Top-level `await` is a *syntax* error in CommonJS, so when the
// app's entry point is CJS index.js rewrites these into require() calls.
const __patcherHttpsProxyAgent = (await import('https-proxy-agent')).HttpsProxyAgent;
const __patcherExpress = (await import('express')).default;
const __patcherHttps = (await import('https')).default;
const __patcherFs = (await import('fs')).default;
const __patcherOs = (await import('os')).default;
const __patcherPath = (await import('path')).default;
const __patcherElectron = (await import('electron'));
const __patcherElectronNet = __patcherElectron.net || __patcherElectron.default?.net;
// --- End Patcher Imports ---

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

const __patcherProxyUrl = (() => {
  const raw = (globalProxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
  if (!raw) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return `http://${raw}`;
  return /^https?:\/\//i.test(raw) ? raw : '';
})();

const __patcherProxyAgent = (() => {
  if (!__patcherProxyUrl) return undefined;
  try {
    return new __patcherHttpsProxyAgent(__patcherProxyUrl);
  } catch (e) {
    console.error(`[Patcher] Ignoring invalid proxy URL "${__patcherProxyUrl}":`, e?.message || e);
    return undefined;
  }
})();
let __patcherOfflineUntil = 0;

const __patcherRequestOnce = (method, url, extraOpts = {}, redirectCount = 0) => new Promise((resolve, reject) => {
  const reqOpts = {
    method,
    ...(__patcherProxyAgent ? { agent: __patcherProxyAgent } : { autoSelectFamilyAttemptTimeout: 5000, ...extraOpts }),
  };

  const req = __patcherHttps.request(url, reqOpts, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject);
    res.on('close', () => {
      if (!res.complete) reject(Object.assign(new Error(`Premature close (${method} ${url})`), { code: 'ECONNRESET' }));
    });
    res.on('end', () => {
      const data = Buffer.concat(chunks);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectCount >= 5) return reject(new Error('Too many redirects'));
        let nextUrl;
        try {
          nextUrl = new URL(res.headers.location, url);
        } catch (e) {
          return reject(e);
        }
        if (nextUrl.protocol !== 'https:') return reject(new Error(`Unsupported redirect protocol: ${nextUrl.protocol}`));
        return resolve(__patcherRequestOnce(method, nextUrl.toString(), extraOpts, redirectCount + 1));
      }
      resolve({ data, statusCode: res.statusCode, headers: res.headers });
    });
  });
  req.setTimeout(15000, () => req.destroy(Object.assign(new Error(`Request timeout (${method} ${url})`), { code: 'ETIMEDOUT' })));
  req.on('error', reject);
  req.end();
});

const __patcherIsTransientNetErr = err => {
  const codes = new Set([err?.code, ...(Array.isArray(err?.errors) ? err.errors.map(e => e?.code) : [])]);
  return ['ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH'].some(c => codes.has(c));
};

// Resilient HTTP request helper: retries transient DNS/IPv6 dual-stack timeouts
// (e.g. Node's 250ms autoSelectFamily timeout on Linux), falls back to IPv4,
// and finally falls back to Chromium's net.fetch when Electron is ready.
const __patcherRequest = async (method, url) => {
  const attempts = __patcherProxyAgent ? [{}, {}] : [{}, { family: 4 }, { family: 4 }];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const result = await __patcherRequestOnce(method, url, attempts[i]);
      __patcherOfflineUntil = 0;
      return result;
    } catch (err) {
      lastErr = err;
      if (!__patcherIsTransientNetErr(err)) break;
      if (i < attempts.length - 1) await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
  }
  if (!__patcherProxyAgent && typeof app !== 'undefined' && app.isReady() && __patcherElectronNet?.fetch) {
    try {
      const res = await __patcherElectronNet.fetch(url, { method, signal: AbortSignal.timeout(15000) });
      const data = Buffer.from(await res.arrayBuffer());
      __patcherOfflineUntil = 0;
      return { data, statusCode: res.status, headers: Object.fromEntries(res.headers.entries()) };
    } catch (netErr) {
      lastErr = netErr;
    }
  }
  __patcherOfflineUntil = Date.now() + 15000;
  throw lastErr;
};

const __patcherPort = process.env.PATCHER_PORT || 5067;
const __patcherCacheUser = (() => {
  try { return __patcherOs.userInfo().username; } catch (e) { return process.env.USER || process.env.USERNAME || 'default'; }
})().replace(/[^a-zA-Z0-9._-]/g, '_');
const __patcherTempPath = __patcherPath.join(__patcherOs.tmpdir(), `httptoolkit-patch-${__patcherCacheUser}`);

// Point the app to our local server instead of the real one
process.env.APP_URL = `http://localhost:${__patcherPort}`;
console.log(`[Patcher] Temp path: ${__patcherTempPath}`);

const __patcherApp = __patcherExpress();
__patcherApp.disable('x-powered-by');

// LAYER 2: Intercept account API calls directly
// Handles any endpoint the account store calls, so even if JS regex fails, app still gets pro user
__patcherApp.all(/^\/__patcher_api\/(.*)/, (req, res) => {
  console.log(`[Patcher] API intercept: ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Neutralize get-prices to prevent infinite retry loop in loadPlanPricesUntilSuccess()
  // Must satisfy () => Object.values(t.SubscriptionPlans).some(e => !e.prices) across all 4 plans
  if (req.url.includes('get-prices')) {
    return res.json({
      success: true,
      response: {
        products: [
          { product_id: 550380, currency: 'USD', price: { net: 0 }, subscription: { interval: 'month' } },
          { product_id: 550382, currency: 'USD', price: { net: 0 }, subscription: { interval: 'year' } },
          { product_id: 550789, currency: 'USD', price: { net: 0 }, subscription: { interval: 'month' } },
          { product_id: 550788, currency: 'USD', price: { net: 0 }, subscription: { interval: 'year' } }
        ]
      }
    });
  }

  const user = JSON.parse(JSON.stringify(__patcherProUser));
  user.subscription.expiry = new Date(user.subscription.expiry);
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

  // Block service worker - it causes caching headaches but needs to return 200 dummy script to prevent startup error
  if (new URL(req.url, process.env.APP_URL).pathname === '/ui-update-worker.js') {
    res.set('Content-Type', 'application/javascript');
    return res.status(200).send('self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", () => self.clients.claim());');
  }

  if (!__patcherFs.existsSync(__patcherTempPath)) {
    __patcherFs.mkdirSync(__patcherTempPath, { recursive: true });
  }

  try {
    // If cached, check upstream mtime once; if offline/unreachable, serve cache cleanly.
    if (__patcherFs.existsSync(filePath)) {
      if (Date.now() < __patcherOfflineUntil) {
        return res.sendFile(filePath);
      }
      try {
        const head = await __patcherRequest('HEAD', `https://app.httptoolkit.tech${req.url}`);
        if (head.statusCode < 200 || head.statusCode >= 300) {
          return res.sendFile(filePath);
        }
        const remoteDate = head.headers['last-modified'] ? new Date(head.headers['last-modified']) : null;
        if (remoteDate && !Number.isNaN(remoteDate.getTime()) && remoteDate < new Date(__patcherFs.statSync(filePath).mtime)) {
          return res.sendFile(filePath);
        }
      } catch (e) {
        return res.sendFile(filePath);
      }
    }

    // Download directly from upstream (resilient request handles IPv4 fallback & retries)
    let remoteFile;
    try {
      remoteFile = await __patcherRequest('GET', `https://app.httptoolkit.tech${req.url}`);
    } catch (e) {
      if (__patcherFs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
      console.error(`[Patcher] Offline/fetch failed for ${req.url}:`, e?.message || e);
      return res.status(404).send('No internet and file not cached');
    }

    if (remoteFile.statusCode < 200 || remoteFile.statusCode >= 300) {
      if (__patcherFs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
      for (const [key, value] of Object.entries(remoteFile.headers)) {
        if (['transfer-encoding', 'connection', 'content-length', 'content-encoding', 'keep-alive', 'upgrade'].includes(key.toLowerCase())) continue;
        res.setHeader(key, value);
      }
      return res.status(remoteFile.statusCode).send(remoteFile.data);
    }

    for (const [key, value] of Object.entries(remoteFile.headers)) {
      if (['transfer-encoding', 'connection', 'content-length', 'content-encoding', 'keep-alive', 'upgrade'].includes(key.toLowerCase())) continue;
      res.setHeader(key, value);
    }

    // Create directories if needed
    const mkdirp = dir => {
      if (!__patcherFs.existsSync(dir)) {
        mkdirp(__patcherPath.dirname(dir));
        __patcherFs.mkdirSync(dir);
      }
    };
    mkdirp(__patcherPath.dirname(filePath));

    let data = remoteFile.data;

    // LAYER 1: Patch main.js JS directly
    if (new URL(req.url, process.env.APP_URL).pathname === '/main.js') {
      console.log(`[Patcher] Patching main.js...`);
      res.setHeader('Cache-Control', 'no-store');

      data = data.toString();

      // LAYER 1a: Brute-force replace all paid-user checks with stubs on Object.prototype
      // This guarantees isPaidUser() etc. always return true even on plain JSON objects
      const stubMethods = [
        'Object.defineProperty(Object.prototype,"__p_isPaid",{value:function(){return true},configurable:true,writable:true,enumerable:false});',
        'Object.defineProperty(Object.prototype,"__p_hasSub",{value:function(){return true},configurable:true,writable:true,enumerable:false});',
        'Object.defineProperty(Object.prototype,"__p_isPastDue",{value:function(){return false},configurable:true,writable:true,enumerable:false});',
      ].join('');

      let beforeCount = data.length;
      data = data.replaceAll('.isPaidUser()', '.__p_isPaid()');
      data = data.replaceAll('.userHasSubscription()', '.__p_hasSub()');
      data = data.replaceAll('.isPastDueUser()', '.__p_isPastDue()');

      if (data.length !== beforeCount) {
        data = stubMethods + data;
        console.log(`[Patcher] Brute-force method stubs injected`);
      }

      // LAYER 1d: Opt out of PostHog analytics when it initialises. Only blocking its
      // requests (see onBeforeSendHeaders) makes it retry them endlessly.
      data = data.replaceAll('api_host:"https://events.httptoolkit.tech"', 'opt_out_capturing_by_default:!0,api_host:"https://events.httptoolkit.tech"');

      // LAYER 1c: Keep the MCP / remote-control bridge working. Because we fake a
      // logged-in Pro user without a real account JWT, the UI's `userJwt` getter
      // throws "No JWT found for logged in user", which crashes the operations
      // client before it can register with the server bridge. Hand it a dummy
      // token instead — the server side (patched in index.js) accepts any JWT.
      const jwtThrow = 'throw new Error("No JWT found for logged in user")';
      if (data.includes(jwtThrow)) {
        data = data.replace(jwtThrow, 'return"htk-patched-jwt"');
        console.log(`[Patcher] Neutralised userJwt throw for MCP bridge`);
      }

      // LAYER 1b: Also try regex-based user data override for deeper integration
      const accStoreName =
        data.match(/class ([0-9A-Za-z_$]+)\s*\{\s*constructor\s*\(\s*e\s*\)\s*\{\s*this\.goToSettings\s*=\s*e/)?.[1] ||
        data.match(/class ([0-9A-Za-z_$]+)[^{]*\{[^}]{0,200}goToSettings/)?.[1];

      const modName =
        data.match(/([0-9A-Za-z_$]+)\.(getLatestUserData|getLastUserData)/)?.[1];

      const userJson = JSON.stringify(__patcherProUser);
      const userInit = `const __pUser=${userJson};__pUser.subscription.expiry=new Date(__pUser.subscription.expiry);__pUser.__p_isPaid=()=>true;__pUser.__p_hasSub=()=>true;__pUser.__p_isPastDue=()=>false;`;

      if (!accStoreName) {
        console.error(`[Patcher] Couldn't find account store class - relying on API interception + brute-force stubs`);
      } else if (!modName) {
        console.error(`[Patcher] Couldn't find user data module - relying on API interception + brute-force stubs`);
      } else {
        const classPattern = new RegExp(`class ${accStoreName}\\s*\\{`);
        let patched = data.replace(
          classPattern,
          `["getLatestUserData","getLastUserData"].forEach(p=>Object.defineProperty(${modName},p,{value:()=>__pUser}));class ${accStoreName}{`
        );

        if (patched === data) {
          console.error(`[Patcher] JS inject failed - relying on API interception + brute-force stubs`);
        } else {
          data = userInit + patched;
          console.log(`[Patcher] main.js patched successfully (regex + brute-force)!`);
        }
      }
    }

    // LAYER 1d: Neutralize price lookup throw in vendor bundles if present
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      let dataStr = data.toString();
      const fullTarget = 'async function i(){const e=await fetch(`${o.ACCOUNTS_API_BASE}/get-prices`);if(!e.ok)throw console.log(e),new Error(`Failed to look up prices, got ${e.status}: ${e.statusText}`);const n=await e.json();if(!n.success)throw console.log(n),new Error("Price lookup request was unsuccessful");return n.response.products.forEach(e=>{const n=Object.values(t.SubscriptionPlans).find(t=>t.paddleId===e.product_id);if(!n)return;const r=e.currency,o=e.price.net,i="year"===e.subscription.interval?o/12:o;n.prices={rawTotal:o,currency:r,total:a(r,o),monthly:a(r,i)}}),t.SubscriptionPlans}';
      const fullRepl = 'async function i(){Object.values(t.SubscriptionPlans).forEach(n=>{n.prices={rawTotal:0,currency:"USD",total:"$0",monthly:"$0"}});return t.SubscriptionPlans}';
      if (dataStr.includes(fullTarget)) {
        data = dataStr.replace(fullTarget, fullRepl);
        console.log('[Patcher] Replaced full price lookup with instant stub in vendor bundle');
      } else if (dataStr.includes('Price lookup request was unsuccessful')) {
        const vendorTarget = 'if(!n.success)throw console.log(n),new Error("Price lookup request was unsuccessful")';
        const vendorReplacement = 'if(!n.success){n.success=true;if(!n.response)n.response={products:[{product_id:550380,currency:"USD",price:{net:0},subscription:{interval:"month"}},{product_id:550382,currency:"USD",price:{net:0},subscription:{interval:"year"}},{product_id:550789,currency:"USD",price:{net:0},subscription:{interval:"month"}},{product_id:550788,currency:"USD",price:{net:0},subscription:{interval:"year"}}]};}';
        data = dataStr.replace(vendorTarget, vendorReplacement);
        console.log('[Patcher] Neutralised price lookup throw in vendor bundle');
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
  // Remember each request's real browser Origin so we can reflect it back in the
  // CORS response. Reflecting (instead of hard-coding an origin) is what lets the
  // account/pricing fetches survive being redirected to our local __patcher_api:
  // a cross-origin redirect taints the origin, so the response must echo whatever
  // the browser actually sent, with credentials allowed.
  const __patcherOriginByReq = new Map();

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    // Block telemetry
    const blocked = ['events.httptoolkit.tech'];
    try {
      const host = new URL(details.url).hostname;
      if (blocked.includes(host) || details.url?.includes('sentry')) {
        return callback({ cancel: true });
      }
    } catch (e) { }

    const origin = details.requestHeaders.Origin ?? details.requestHeaders.origin
    if (origin) __patcherOriginByReq.set(details.id, origin)

    // The local HTTP Toolkit server (127.0.0.1) gates every endpoint — the REST/
    // GraphQL API AND the MCP/remote-control /ui-operations WebSocket — on the
    // request Origin being exactly https://app.httptoolkit.tech (prod builds).
    // Our UI runs on localhost, so spoof the Origin for requests to that server
    // only. We must NOT spoof it for requests to our own proxy (localhost:${port}),
    // because that breaks the browser CORS check on the redirected account API.
    let host = ''
    try { host = new URL(details.url).hostname } catch (e) { }
    if (host === '127.0.0.1') {
      details.requestHeaders.Origin = 'https://app.httptoolkit.tech'
    }

    callback({ requestHeaders: details.requestHeaders });
  });

  // LAYER 2: Redirect any account/auth API calls to our fake endpoint
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['https://api.httptoolkit.tech/*', 'https://accounts.httptoolkit.tech/*'] },
    (details, callback) => {
      try {
        const url = new URL(details.url);
        // Prices aren't a user object: answering with one makes the UI retry forever,
        // so let the real API (which allows our origin) answer this one
        if (url.pathname.endsWith('/get-prices')) return callback({});
        const redirectURL = `http://localhost:${__patcherPort}/__patcher_api${url.pathname}${url.search}`;
        console.log(`[Patcher] Redirecting API: ${details.url} -> ${redirectURL}`);
        callback({ redirectURL });
      } catch (e) {
        callback({});
      }
    }
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    // Drop any existing CORS headers (from the real server or our own express app)
    // so we don't end up with duplicate/conflicting values.
    for (const key of Object.keys(headers)) {
      if (/^access-control-allow-(origin|credentials)$/i.test(key)) delete headers[key];
    }
    const origin = __patcherOriginByReq.get(details.id) ?? `http://localhost:${__patcherPort}`;
    __patcherOriginByReq.delete(details.id);
    headers['Access-Control-Allow-Origin'] = [origin];
    headers['Access-Control-Allow-Credentials'] = ['true'];
    callback({ responseHeaders: headers });
  });
});