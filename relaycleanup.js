/*
 * MeshCentral Relay Cleanup plugin
 *
 * Lists device-sharing links (Desktop / Terminal / Web Relay / Files) and
 * flags ones that are stale, have no expiration, or duplicate another active
 * share of the same type on the same device. Supports bulk delete and bulk
 * expiration update from an admin tab.
 */

"use strict";

module.exports.relaycleanup = function (parent) {
    const obj = {};
    obj.parent = parent;                    // PluginHandler
    obj.meshServer = parent.parent;         // main MeshCentral server
    obj.db = obj.meshServer.db;

    // Share protocol code → human label.
    // NOTE: These values match current MeshCentral (1.1.x) device-share records.
    // Verify against meshuser.js "createDeviceShareLink" if a future version
    // changes the encoding.
    // Share protocol codes. Confirmed from live 1.1.57 data:
    //   1 = Terminal (SSH), 8 = Web Relay (HTTP with port)
    // Others are inferred from MeshCentral source and may need adjustment.
    const PROTOCOL_LABELS = {
        1: "Terminal",
        2: "Desktop",
        5: "Files",
        8: "Web Relay (HTTP)",
        16: "Web Relay (HTTPS)"
    };

    function labelForProtocol(p) {
        return PROTOCOL_LABELS[p] || ("Unknown (p=" + p + ")");
    }

    function settings() {
        // Plugin settings are merged by MeshCentral at load; fall back to defaults.
        const s = (obj.parent.config && obj.parent.config.relaycleanup) || {};
        return {
            staleHours: Number.isFinite(s.staleHours) ? s.staleHours : 12,
            auditEvents: s.auditEvents !== false
        };
    }

    // ----- Core: load + classify shares -----------------------------------

    async function loadAllShares() {
        return new Promise((resolve) => {
            obj.db.GetAllType("deviceshare", (err, docs) => {
                resolve(err ? [] : (docs || []));
            });
        });
    }

    async function loadNodesAndUsers() {
        // Pull minimal node + user info for display. Small workspaces only —
        // for very large deployments this should be switched to targeted lookups.
        const nodeIndex = {};
        const userIndex = {};
        await new Promise((resolve) => {
            obj.db.GetAllType("node", (err, docs) => {
                (docs || []).forEach((n) => { nodeIndex[n._id] = n; });
                resolve();
            });
        });
        await new Promise((resolve) => {
            obj.db.GetAllType("user", (err, docs) => {
                (docs || []).forEach((u) => { userIndex[u._id] = u; });
                resolve();
            });
        });
        return { nodeIndex, userIndex };
    }

    function classify(shares, staleHours) {
        const now = Date.now();
        const staleMs = staleHours * 3600 * 1000;

        // Group by nodeid + protocol + userid to detect duplicates.
        const groups = {};
        shares.forEach((s) => {
            const key = [s.nodeid, s.p, s.userid].join("|");
            (groups[key] = groups[key] || []).push(s);
        });

        return shares.map((s) => {
            const start = s.startTime || s.time || s.creationTime || s.created || 0;
            const expire = s.expireTime || 0;
            const ageMs = start ? (now - start) : 0;

            const flags = {
                noExpiry: !expire,
                stale: start > 0 && ageMs > staleMs,
                expired: expire > 0 && expire < now,
                duplicate: false,
                orphaned: false  // filled in by buildReport (needs node index)
            };

            const group = groups[[s.nodeid, s.p, s.userid].join("|")];
            if (group.length > 1) {
                // Mark all but the newest as duplicates.
                const newest = group.reduce((a, b) => ((b.startTime || 0) > (a.startTime || 0) ? b : a));
                if (s._id !== newest._id) flags.duplicate = true;
            }

            return { share: s, flags, ageMs };
        });
    }

    async function buildReport() {
        const { staleHours } = settings();
        const [shares, dirs] = await Promise.all([loadAllShares(), loadNodesAndUsers()]);
        const classified = classify(shares, staleHours);

        return classified.map((c) => {
            const s = c.share;
            const node = dirs.nodeIndex[s.nodeid];
            const user = dirs.userIndex[s.userid];
            c.flags.orphaned = !node;
            // Creation/start time has moved between MeshCentral versions — try
            // several plausible fields so something displays.
            const startTime = s.startTime || s.time || s.creationTime || s.created || 0;
            const ageMs = startTime ? (Date.now() - startTime) : 0;
            return {
                id: s._id,
                publicid: s.publicid || s.extrakey,
                nodeid: s.nodeid,
                nodeName: node ? node.name : "(unknown device)",
                userid: s.userid,
                userName: user ? (user.name || user._id) : (s.userid || "(unknown)"),
                guestName: s.guestName || null,
                protocol: s.p,
                protocolLabel: labelForProtocol(s.p),
                port: s.port || null,
                startTime,
                expireTime: s.expireTime || 0,
                ageMs,
                viewOnly: !!s.viewOnly,
                consent: s.consent || 0,
                url: s.url || null,
                flags: c.flags
            };
        });
    }

    // ----- Mutations ------------------------------------------------------

    function removeShare(id) {
        return new Promise((resolve, reject) => {
            try {
                obj.db.Remove(id, (err) => err ? reject(err) : resolve());
            } catch (e) { reject(e); }
        });
    }

    function updateShareExpiry(id, expireTime) {
        return new Promise((resolve) => {
            obj.db.Get(id, (err, docs) => {
                if (err || !docs || !docs.length) return resolve(false);
                const doc = docs[0];
                doc.expireTime = expireTime;
                obj.db.Set(doc, () => resolve(true));
            });
        });
    }

    function dispatchAudit(user, action, detail) {
        if (!settings().auditEvents) return;
        try {
            obj.meshServer.DispatchEvent(["*", user && user._id].filter(Boolean), obj, {
                etype: "plugin",
                action: "pluginaction",
                plugin: "relaycleanup",
                msgid: 0,
                msgArgs: [action, detail],
                msg: "Relay Cleanup: " + action + " — " + detail,
                domain: user && user.domain
            });
        } catch (_) { /* non-fatal */ }
    }

    async function bulkDelete(ids, user) {
        // Chunk to avoid overwhelming the DB layer on large batches.
        const chunkSize = 50;
        let ok = 0, failed = 0;
        for (let i = 0; i < ids.length; i += chunkSize) {
            const slice = ids.slice(i, i + chunkSize);
            const results = await Promise.all(slice.map((id) =>
                removeShare(id).then(() => true).catch(() => false)
            ));
            results.forEach((r) => { r ? ok++ : failed++; });
        }
        dispatchAudit(user, "bulkDelete", ok + " share(s) removed, " + failed + " failed");
        return { deleted: ok, failed };
    }

    // Note: setexpiry removed in 0.1.5. MeshCentral 1.1.x doesn't store
    // expireTime on deviceshare records — the expiration is encoded inside
    // the encrypted URL cookie. Setting it in the DB has no effect on
    // share validity. Left here as a placeholder in case a future version
    // starts honouring the DB field.
    async function bulkSetExpiry() { return { updated: 0 }; }

    // ----- HTTP admin handler ---------------------------------------------

    obj.handleAdminReq = async function (req, res, user, pluginHandler) {
        // MeshCentral's pluginHandler gates admin routes to site admins already;
        // we just defensively bail if somehow no user was resolved.
        if (!user) {
            res.status(401).set("Content-Type", "application/json")
                .end(JSON.stringify({ ok: false, error: "plugin:no-user", method: req.method }));
            return;
        }

        const q = req.query || {};
        const b = req.body || {};
        const action = (q.action || b.action || "view").toString();

        try {
            if (action === "list") {
                const rows = await buildReport();
                res.set("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, settings: settings(), rows }));
                return;
            }

            if (action === "raw") {
                // Debug: first 5 raw deviceshare records — so we can see which
                // fields this MeshCentral build populates.
                const shares = await loadAllShares();
                res.set("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, count: shares.length, sample: shares.slice(0, 5) }, null, 2));
                return;
            }

            if (action === "whoami") {
                // Debug: echo what the plugin sees about the caller + method.
                res.set("Content-Type", "application/json");
                res.end(JSON.stringify({
                    ok: true,
                    method: req.method,
                    user: user ? { _id: user._id, name: user.name, siteadmin: user.siteadmin, domain: user.domain } : null
                }, null, 2));
                return;
            }

            if (action === "delete") {
                const ids = parseIds(req);
                const result = await bulkDelete(ids, user);
                res.set("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, ...result }));
                return;
            }

            if (action === "setexpiry") {
                const ids = parseIds(req);
                const expireTime = Number(b.expireTime || q.expireTime || 0) || 0;
                const result = await bulkSetExpiry(ids, expireTime, user);
                res.set("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, ...result }));
                return;
            }

            // Default: render admin page.
            res.set("Content-Type", "text/html; charset=utf-8");
            res.end(renderAdminPage(settings()));
        } catch (e) {
            res.status(500);
            res.set("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
        }
    };

    function parseIds(req) {
        const raw = (req.body && req.body.ids) || (req.query && req.query.ids);
        if (!raw) return [];
        if (Array.isArray(raw)) return raw;
        try { return JSON.parse(raw); } catch (_) { return String(raw).split(","); }
    }

    // ----- UI (inline for now — single file is easier to vendor) ----------

    function renderAdminPage(s) {
        return `<!doctype html>
<html><head><meta charset="utf-8"><title>Relay Cleanup</title>
<style>
 body{font:13px/1.4 system-ui,sans-serif;margin:12px;color:#222}
 h2{margin:0 0 8px}
 .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0;padding:8px;background:#f3f4f6;border-radius:6px}
 .bar label{display:inline-flex;gap:4px;align-items:center}
 table{border-collapse:collapse;width:100%;font-size:12px}
 th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
 th{background:#eef;position:sticky;top:0}
 tr.dup{background:#fff4e5}
 tr.orphaned{background:#e0e7ff}
 .badge.orph{background:#6366f1;color:#fff}
 tr.noexp{background:#fde8e8}
 tr.stale{background:#fff9db}
 tr.expired{color:#888;text-decoration:line-through}
 .badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:11px;margin-right:3px;background:#ddd}
 .badge.noexp{background:#f87171;color:#fff}
 .badge.stale{background:#f59e0b;color:#fff}
 .badge.dup{background:#fb923c;color:#fff}
 .badge.expired{background:#9ca3af;color:#fff}
 button{padding:5px 10px;border:1px solid #888;background:#fff;border-radius:4px;cursor:pointer}
 button.danger{background:#dc2626;color:#fff;border-color:#991b1b}
 .muted{color:#666}
 code{font-size:11px}
</style></head>
<body>
<h2>Device Share Cleanup</h2>
<p class="muted">MeshCentral 1.1.x stores share expiration inside the encrypted URL, not in the DB record, so creation time and expiry aren't shown here. This tool focuses on finding <b>duplicates</b> (multiple active shares of the same type/user/device) and pruning the backlog.</p>

<div class="bar">
 <button onclick="refresh()">Refresh</button>
 <label><input type="checkbox" id="f-dup" checked>Duplicates</label>
 <label><input type="checkbox" id="f-orph" checked>Orphaned (device deleted)</label>
 <label><input type="checkbox" id="f-all">Show all</label>
 <span class="muted" id="summary"></span>
</div>

<div class="bar">
 <label><input type="checkbox" id="selall" onchange="toggleAll(this.checked)"> Select all visible</label>
 <button class="danger" onclick="bulkDelete()">Delete Selected</button>
 <button onclick="selectDuplicatesOnly()">Select all duplicates (keep newest)</button>
 <button onclick="selectOrphansOnly()">Select all orphaned</button>
 <span id="selcount" class="muted">0 selected</span>
 <button onclick="debugRaw()" title="Show raw share fields in console">debug</button>
 <button onclick="debugWhoami()" title="Show user info seen by plugin">whoami</button>
</div>

<table id="tbl">
 <thead><tr>
  <th></th><th>Device</th><th>User</th><th>Type</th><th>Guest</th><th>Port</th><th>Flags</th><th>Public ID</th>
 </tr></thead>
 <tbody></tbody>
</table>

<script>
let ROWS=[];
const base = location.pathname + '?pin=relaycleanup';

function fmtTime(ms){ return ms? new Date(ms).toLocaleString() : '—'; }
function fmtAge(ms){
  if(!ms) return '—';
  const h = ms/3600000;
  if(h<24) return h.toFixed(1)+'h';
  return (h/24).toFixed(1)+'d';
}

async function refresh(){
  const r = await fetch(base+'&action=list',{credentials:'same-origin'}).then(r=>r.json());
  ROWS = r.rows || [];
  render();
}

function visible(row){
  if(document.getElementById('f-all').checked) return true;
  if(row.flags.duplicate && document.getElementById('f-dup').checked) return true;
  if(row.flags.orphaned  && document.getElementById('f-orph').checked) return true;
  return false;
}

function render(){
  const tbody = document.querySelector('#tbl tbody');
  tbody.innerHTML = '';
  let shown=0, dp=0, orph=0;
  ROWS.forEach(row=>{
    if(row.flags.duplicate) dp++;
    if(row.flags.orphaned)  orph++;
    if(!visible(row)) return;
    shown++;
    const tr = document.createElement('tr');
    if(row.flags.duplicate) tr.classList.add('dup');
    if(row.flags.orphaned)  tr.classList.add('orphaned');
    const badges =
      (row.flags.duplicate?'<span class="badge dup">duplicate</span>':'')+
      (row.flags.orphaned ?'<span class="badge orph">orphaned</span>':'');
    tr.innerHTML =
      '<td><input type="checkbox" class="sel" data-id="'+row.id+'"></td>'+
      '<td>'+esc(row.nodeName)+'<div class="muted"><code>'+esc(row.nodeid)+'</code></div></td>'+
      '<td>'+esc(row.userName)+'</td>'+
      '<td>'+esc(row.protocolLabel)+(row.viewOnly?' <span class="muted">(view-only)</span>':'')+'</td>'+
      '<td>'+esc(row.guestName||'')+'</td>'+
      '<td>'+(row.port||'')+'</td>'+
      '<td>'+badges+'</td>'+
      '<td><code>'+esc(row.publicid||'')+'</code></td>';
    tbody.appendChild(tr);
  });
  document.getElementById('summary').textContent =
    'Total: '+ROWS.length+' | Shown: '+shown+' | Duplicates: '+dp+' | Orphaned: '+orph;
  updateCount();
  document.querySelectorAll('.sel').forEach(c=>c.addEventListener('change',updateCount));
}

function selectDuplicatesOnly(){
  document.querySelectorAll('.sel').forEach(c=>c.checked=false);
  ROWS.forEach(row=>{
    if(!row.flags.duplicate) return;
    const cb = document.querySelector('.sel[data-id="'+CSS.escape(row.id)+'"]');
    if(cb) cb.checked = true;
  });
  updateCount();
}
function selectOrphansOnly(){
  document.querySelectorAll('.sel').forEach(c=>c.checked=false);
  ROWS.forEach(row=>{
    if(!row.flags.orphaned) return;
    const cb = document.querySelector('.sel[data-id="'+CSS.escape(row.id)+'"]');
    if(cb) cb.checked = true;
  });
  updateCount();
}

function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function selectedIds(){ return Array.from(document.querySelectorAll('.sel:checked')).map(c=>c.dataset.id); }
function updateCount(){ document.getElementById('selcount').textContent = selectedIds().length+' selected'; }
function toggleAll(v){ document.querySelectorAll('.sel').forEach(c=>c.checked=v); updateCount(); }

async function bulkDelete(){
  const ids = selectedIds();
  if(!ids.length) return alert('Nothing selected');
  if(!confirm('Delete '+ids.length+' share(s)? This cannot be undone.')) return;
  const r = await fetch(base+'&action=delete&ids='+encodeURIComponent(JSON.stringify(ids)),{credentials:'same-origin'}).then(r=>r.json());
  if(!r.ok) return alert('Error: '+r.error);
  alert('Deleted '+r.deleted);
  refresh();
}

async function debugRaw(){
  const r = await fetch(base+'&action=raw',{credentials:'same-origin'}).then(r=>r.text());
  console.log('[relaycleanup] raw:', r);
  alert('Raw sample logged to console (F12).');
}
async function debugWhoami(){
  const getR = await fetch(base+'&action=whoami',{credentials:'same-origin'}).then(r=>r.text());
  const postR = await fetch(base+'&action=whoami',{method:'POST',credentials:'same-origin'}).then(r=>r.text());
  console.log('[relaycleanup] GET whoami:', getR);
  console.log('[relaycleanup] POST whoami:', postR);
  alert('GET and POST whoami logged to console (F12).');
}

['f-dup','f-orph','f-all'].forEach(id=>document.getElementById(id).addEventListener('change',render));
refresh();
</script>
</body></html>`;
    }

    // ----- Plugin lifecycle hooks -----------------------------------------

    obj.server_startup = function () {
        // Nothing to bootstrap currently. Reserved for scheduled auto-prune.
    };

    obj.exports = ["server_startup"];
    return obj;
};
