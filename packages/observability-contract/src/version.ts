/**
 * The contract package version, exported as `SPEC_VERSION`. Every event
 * envelope emits this string in its `spec_version` field, so sinks can
 * refuse or migrate events emitted against an older contract version.
 *
 * Kept in sync with package.json manually (a version-bump script updates
 * both together during release).
 */
export const SPEC_VERSION = "0.1.0-alpha.28";
