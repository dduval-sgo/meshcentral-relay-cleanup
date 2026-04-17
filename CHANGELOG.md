# Changelog

## 0.1.5

- Rework UI to match what MeshCentral 1.1.x actually stores on deviceshare
  records: no `startTime`/`expireTime` in the DB (expiration is encrypted
  inside the share URL's `c=` param). Drop the age/stale/expired filters
  and `setexpiry` bulk action — they can't work on this version.
- Focus the tool on duplicate detection + deletion. Add `Select all
  duplicates (keep newest)` shortcut button.
- Show `port` column (relevant for Web Relay shares).

## 0.1.4

- Switch bulk actions from POST to GET (same handler, same auth, avoids any
  POST-specific gate in MeshCentral's `/pluginadmin.ashx` path).
- Tag plugin-side 401s with a JSON body so they can be told apart from
  MeshCentral's upstream `Unauthorized` text response.
- Add `debug` / `whoami` buttons to the toolbar for field inspection.

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
