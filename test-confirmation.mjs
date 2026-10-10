import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const start = source.indexOf("  const { closeConfirmed }");
const end = source.indexOf("  const filePath", start);
const confirmationStep = source.slice(start, end);

for (const answer of [false, undefined, true]) {
  let shutdownCalls = 0;
  const confirmAndClose = vm.runInNewContext(
    "(async () => {" + confirmationStep + "})",
    {
      prompts: async (options) => {
        assert.equal(options.initial, false);
        return { closeConfirmed: answer };
      },
      closeToolkitBeforePatch: async () => {
        shutdownCalls++;
      },
      path: { dirname: (value) => value },
      appPath: "test-install",
      console: { log() {} },
      chalk: { yellowBright() {} },
    },
  );
  await confirmAndClose();
  assert.equal(shutdownCalls, answer === true ? 1 : 0);
}
console.log(
  "PASS: only an explicit Yes allows shutdown; No and cancellation leave processes alone.",
);
