/**
 * Hostile strings for AC-09: markup, script and event-handler payloads placed in every free-text field a manifest
 * can carry (owner, version, revision, source file). They must appear as literal text in the UI and in the static
 * report, and `window.__pwned` must never be set. Synthetic; nothing here is a real payload target.
 */
export const HOSTILE = {
  owner: '<img src=x onerror="window.__pwned=1">',
  version: '"><script>window.__pwned=1</script>',
  revision: "<svg/onload=window.__pwned=1>",
  file: "javascript:window.__pwned=1//<b>x</b>&amp;",
} as const;
