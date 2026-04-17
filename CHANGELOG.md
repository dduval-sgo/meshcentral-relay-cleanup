# Changelog

## 0.1.3

- Drop redundant siteadmin gate (MeshCentral's plugin handler enforces it);
  was causing 401s on bulk actions for legitimate admins.
- Attach `credentials: 'same-origin'` to fetch calls so session cookies ride
  with POSTs.
- Batch bulk deletes in parallel chunks of 50 with per-item error handling
  instead of serial await (avoids 500s on large batches).
- Fall back through alternate creation-time field names (`time`,
  `creationTime`, `created`) in case `startTime` isn't populated in this
  MeshCentral build.
- Add `?action=raw` debug endpoint that returns the first 5 raw deviceshare
  records so we can confirm which fields this server actually stores.

## 0.1.2

- Fix crash when opening the admin panel: `req.body` is undefined on plugin
  admin routes (no body-parser middleware). Guard all `req.body` reads and
  move bulk-action payloads into the query string.

## 0.1.1

- Fix plugin manifest: rename `versionsUrl` → `versionHistoryUrl`, add
  `repository` block, drop non-standard `defaultSettings` field. Corrects
  "Download Plugin" modal failure in MeshCentral UI.

## 0.1.0

- Initial release: list, filter, bulk delete, and bulk set-expiry for
  device sharing links. Flags no-expiry, stale (>configurable hours),
  already-expired, and duplicate shares.
