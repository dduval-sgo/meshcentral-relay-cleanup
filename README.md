# MeshCentral Relay Cleanup

A MeshCentral plugin that scans **device sharing links** (Desktop, Terminal,
Web Relay, Files) and flags ones that are:

- **No expiry** — `expireTime` is unset/zero
- **Stale** — older than the configured threshold (default 12h)
- **Already expired** — `expireTime` in the past, not yet cleaned
- **Duplicate** — more than one active share of the same *type* on the same
  device for the same user (the newest is kept, older ones are flagged)

The admin tab lets you filter, bulk-delete, or bulk-update expiry on selected
shares.

## Install

MeshCentral admin → **Plugins** → *Add plugin by URL*, pointing at the raw
`config.json` in this repo:

```
https://raw.githubusercontent.com/dduval-sgo/meshcentral-relay-cleanup/main/config.json
```

(Replace `OWNER` with your GitHub org/user before publishing.)

Plugins must be enabled in `meshcentral-data/config.json`:

```json
{ "settings": { "plugins": { "enabled": true } } }
```

## Config

In `meshcentral-data/config.json`:

```json
{
  "plugins": {
    "relaycleanup": {
      "staleHours": 12,
      "auditEvents": true
    }
  }
}
```

## Compatibility

Tested against MeshCentral **1.1.57+**. The plugin reads `deviceshare`
records directly via `obj.db.GetAllType`; the protocol-code mapping in
`relaycleanup.js` (`PROTOCOL_LABELS`) should be reviewed if a future
MeshCentral release changes the `p` field encoding.

## Safety

- Restricted to full site admins.
- Every bulk action requires a confirm dialog.
- If `auditEvents` is enabled (default), delete/update actions dispatch a
  `plugin`/`pluginaction` event into MeshCentral's event stream.

## Known limitations

- No last-used timestamp per share (MeshCentral doesn't track this in the
  `deviceshare` record). Creation age + expiry are the signals used.
- Revoking a share removes the DB record. Any active connection using the
  link will drop on its next relay-server cycle, not instantly.
- Large deployments: `GetAllType('node'|'user')` is fine up to a few
  thousand records. If you exceed that, switch to targeted lookups.
