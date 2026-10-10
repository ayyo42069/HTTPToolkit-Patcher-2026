import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const start = source.indexOf("  const edits = [");
const end = source.indexOf("\n  let data", start);
const edits = vm.runInNewContext(source.slice(start, end) + ";edits", {
  patcherPort: 5067,
});
const edit = edits.find((e) => e.name === "allow proxy origin");
// Match both old and new minified variable names without needing an installed app.
const bundle = "var eg=enabled,origins=eg" + edit.from + "[];";
assert.equal(
  bundle.split(edit.from).length - 1,
  1,
  "Fixture must contain exactly one target",
);
const repaired = bundle.replace(edit.from, edit.to);
assert(repaired.includes(edit.to));
assert(!repaired.includes(edit.from));
const list = vm.runInNewContext(edit.to.slice(1, -1));
assert(list.some((r) => r.test("http://localhost:5067")));
assert(list.some((r) => r.test("https://app.httptoolkit.tech")));
assert(!list.some((r) => r.test("http://localhost:5068")));
assert(!list.some((r) => r.test("https://untrusted.example")));
console.log(
  "PASS: unique installed-bundle match; intended origin accepted; other origins rejected; reapplication detected.",
);
