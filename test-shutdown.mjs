import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { closeToolkitBeforePatch, shutdownScript } from "./shutdown.js";
for (const code of [0, 1]) {
  let finished = false;
  const child = new EventEmitter();
  const run = closeToolkitBeforePatch("C:\\Program Files\\HTTP Toolkit", {
    platform: "win32",
    spawn(command, args, options) {
      assert.equal(command, "powershell.exe");
      assert.equal(options.windowsHide, true);
      assert.equal(
        Buffer.from(args.at(-1), "base64").toString("utf16le"),
        shutdownScript,
      );
      return child;
    },
  }).then(() => {
    finished = true;
  });
  const checked = code
    ? assert.rejects(run, /No patch files were changed/)
    : run;
  await Promise.resolve();
  assert.equal(finished, false, "Must wait for shutdown to finish");
  child.emit("close", code);
  await checked;
  assert.equal(finished, code === 0);
}
const index = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
assert(
  index.indexOf("await closeToolkitBeforePatch(path.dirname(appPath))") <
    index.indexOf("const filePath = path.join(appPath, 'app.asar')"),
);
console.log(
  "PASS: shutdown is awaited before patching; shutdown failure aborts; hidden PowerShell receives exact script.",
);
