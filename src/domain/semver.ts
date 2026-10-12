export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease identifiers after `-`, or null for a release. Build metadata (`+...`) is ignored. */
  readonly prerelease: string | null;
}

const SEMVER = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,100}))?(?:\+[0-9A-Za-z.-]{0,100})?$/;

/** Parse a semantic version (optional `v` prefix). Returns null for anything else. */
export function parseSemver(version: string): SemVer | null {
  const m = SEMVER.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

export interface VersionChange {
  readonly breaking: boolean;
  /** true when either side is not a semantic version, so no ordering could be established. */
  readonly comparable: boolean;
  readonly why: string;
}

/**
 * Is a change of a node's version a break for its dependents? Conservative on purpose (an over-report is a
 * visible finding, an under-report would be a wrong safe verdict):
 * - either side is not semver: breaking;
 * - the major version differs, in either direction (a rollback across a major is breaking too);
 * - major 0 with a different minor, and 0.0.x with a different patch (0.x makes no compatibility promise);
 * - any decrease of minor or patch (a downgrade);
 * - a target that is a prerelease (`1.3.0-alpha.1`, `1.2.4-rc.1`): a prerelease promises nothing, whatever the core;
 * - the same core with a different prerelease, except graduating from a prerelease to the release.
 * Build metadata never matters. Otherwise (minor or patch upgrade to a release at major 1 or above) it is not breaking.
 */
export function classifyVersionChange(before: string, after: string): VersionChange {
  const b = parseSemver(before);
  const a = parseSemver(after);
  if (b === null || a === null) return { breaking: true, comparable: false, why: "not comparable as semantic versions" };
  if (b.major !== a.major) return { breaking: true, comparable: true, why: "major version change" };
  if (b.major === 0 && b.minor !== a.minor) return { breaking: true, comparable: true, why: "minor version change at major 0" };
  if (b.major === 0 && b.minor === 0 && b.patch !== a.patch) return { breaking: true, comparable: true, why: "patch version change at 0.0" };
  const sameCore = a.minor === b.minor && a.patch === b.patch;
  if (a.prerelease !== null && !(sameCore && b.prerelease === a.prerelease)) {
    return { breaking: true, comparable: true, why: "prerelease target" };
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? { breaking: true, comparable: true, why: "version downgrade" } : { breaking: false, comparable: true, why: "minor upgrade" };
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? { breaking: true, comparable: true, why: "version downgrade" } : { breaking: false, comparable: true, why: "patch upgrade" };
  }
  if (b.prerelease === a.prerelease) return { breaking: false, comparable: true, why: "no semantic change" };
  if (b.prerelease !== null && a.prerelease === null) return { breaking: false, comparable: true, why: "prerelease graduated to release" };
  return { breaking: true, comparable: true, why: "prerelease change" };
}
