import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const file = new URL("./patch.js", import.meta.url);
const source = fs.readFileSync(file, "utf8");
let redirect;
const ready = source.slice(source.indexOf("app.on('ready'"));
const session = {
  defaultSession: {
    webRequest: {
      onBeforeSendHeaders() {},
      onHeadersReceived() {},
      onBeforeRequest(filter, handler) {
        redirect = handler;
      },
    },
  },
};
vm.runInNewContext(ready, {
  app: {
    on(event, fn) {
      fn();
    },
  },
  session,
  URL,
  Map,
  console,
  __patcherPort: 5067,
});
let result;
redirect(
  { url: "https://api.httptoolkit.tech/get-prices" },
  (v) => (result = v),
);
assert.equal(
  result.redirectURL,
  undefined,
  "Pricing must reach the real pricing API",
);
assert(
  source.includes("opt_out_capturing_by_default:!0"),
  "Analytics must opt out before initialization",
);
console.log("PASS: pricing routing and analytics opt-out");
const repairStart = source.indexOf("function __patcherRepairTelemetry");
const repairEnd = source.indexOf("function __patcherRepairCachedUI");
const repair = vm.runInNewContext(
  source.slice(repairStart, repairEnd) + ";__patcherRepairTelemetry",
);
const fixture =
  'sdk.init("key",{api_host:"https://events.httptoolkit.tech",autocapture:!1})';
let options;
vm.runInNewContext(repair(fixture), {
  sdk: {
    init(key, opts) {
      options = opts;
    },
  },
});
assert.equal(options.opt_out_capturing_by_default, true);
for (const endpoint of [
  "/api/v1/get-prices",
  "/prices",
  "/subscription-plans",
]) {
  redirect(
    { url: "https://api.httptoolkit.tech" + endpoint },
    (v) => (result = v),
  );
  assert.equal(result.redirectURL, undefined);
}
redirect(
  { url: "https://accounts.httptoolkit.tech/user" },
  (v) => (result = v),
);
assert(result.redirectURL.includes("/__patcher_api/user"));
console.log(
  "PASS: real SDK initialization opts out; pricing variants preserved; account routing preserved",
);

const { removePreviousPatch } = await import("./patch-utils.js");
const original =
  "before\n// ------- Injected by HTTP Toolkit Patcher -------\nold code\n// ------- End patched content -------\nafter";
assert.equal(removePreviousPatch(original), "before\nafter");
assert.equal(removePreviousPatch("unchanged"), "unchanged");
assert.throws(
  () =>
    removePreviousPatch("// ------- Injected by HTTP Toolkit Patcher -------"),
  /incomplete/,
);
console.log(
  "PASS: previous injection removed; unchanged and incomplete files handled.",
);
