import assert from "node:assert/strict";

const PATCH_START = "// ------- Injected by HTTP Toolkit Patcher -------";
const PATCH_END = "// ------- End patched content -------";

/** Remove our previous injection before applying the current patch. */
export function removePreviousPatch(source) {
  const start = source.indexOf(PATCH_START);
  if (start === -1) return source;
  const end = source.indexOf(PATCH_END, start);
  assert(end !== -1, "Previous patch is incomplete; refusing to replace it.");
  return (
    source.slice(0, start) +
    source.slice(end + PATCH_END.length).replace(/^\r?\n/, "")
  );
}
