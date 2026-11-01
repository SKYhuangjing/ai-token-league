// Minimal plugin entry — Magpie's entry resolution requires one, but all real
// behavior lives in the Bun-side hook file (magpie.hooks -> hooks.js) and the
// sync CLI (sync.js). This module exports an empty hook set.
export default async function client() {
  return {};
}
