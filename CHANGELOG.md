# Changelog

## 0.1.1

- Fix plugin manifest: rename `versionsUrl` → `versionHistoryUrl`, add
  `repository` block, drop non-standard `defaultSettings` field. Corrects
  "Download Plugin" modal failure in MeshCentral UI.

## 0.1.0

- Initial release: list, filter, bulk delete, and bulk set-expiry for
  device sharing links. Flags no-expiry, stale (>configurable hours),
  already-expired, and duplicate shares.
