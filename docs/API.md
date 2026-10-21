# Signalpost API (v1)

All JSON responses use one envelope:

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "validation_failed", "message": "Some fields are invalid.", "fields": { "body": "Message cannot be empty." } } }
```

Common error codes: `bad_request` (400, e.g. malformed JSON), `unauthenticated`
/ `session_required` / `invalid_credentials` (401), `forbidden` /
`chat_unavailable` / `origin_not_allowed` (403), `not_found` (404 — also used
for resources that exist but are not yours), `method_not_allowed` (405),
`conflict` / `prechat_required` (409), `payload_too_large` (413),
`csrf_failed` (419), `validation_failed` (422), `rate_limited` (429, with
`Retry-After`), `server_error` (500, with a reference only).

Request bodies are limited to 64 KB. Timestamps are UTC ISO-8601.

---

## 1. Public widget API

Base: `/api/v1/widget/{siteKey}` — `siteKey` is the website's public key (32 hex).

* Headers: `Content-Type: application/json`; `X-Visitor-Token: <token>` once known.
* No cookies. `Origin` (when sent) must equal the website's canonical origin;
  CORS is granted only to that origin. Preflight (`OPTIONS`) is supported.
* Website must be connected and the widget enabled, otherwise `404 chat_unavailable`.

### POST /session
Starts or resumes a visitor session. **Creates a visitor identity if no valid token is sent** — the widget calls this only after the visitor opens the chat or permits analytics.

Response:
```json
{
  "token": "…43 chars…|null",            // returned only when new or rotated: store it
  "visitor": { "id": "a1b2…", "consent_state": "unknown" },
  "chat": {
    "available": true,                    // false = generic "not available" (e.g. blocked)
    "conversation": { "status": "open", "read_only": false } | null,
    "messages": [ { "id": 12, "sender": "visitor|operator|system", "author": "Olivia|null", "client_id": "…|null", "body": "…", "created_at": "…" } ],
    "prechat": { "fields": { "name": "off|optional|required", … }, "missing_required": ["name"], "submitted": false }
  },
  "analytics": { "permitted": false, "needs_prompt": true, "policy_version": "1" }
}
```

### GET /messages?after={messageId}
Messages newer than the cursor in the visitor's **own current conversation**.
Marks operator messages delivered. Response: `{ conversation, messages, chat_available }`.

### POST /messages
`{ "client_message_id": "8–64 chars [A-Za-z0-9-_]", "body": "1–4000 chars" }`
Idempotent per client ID: a retry returns `200` with `"duplicate": true` and the original message; a new message returns `201`.
Errors: `403 chat_unavailable` (blocked/read-only), `409 prechat_required`, `422`.
Closed conversations reopen within the website's reopen window; afterwards a new conversation starts.

### POST /contact
`{ "name"?, "email"?, "phone"? }` — only fields enabled in the pre-chat form are accepted; required fields are enforced. Response `{ "saved": ["name","email"] }` (values are never echoed).

### POST /consent
`{ "analytics": true|false, "source": "widget|wp_consent_api|custom" }` → `{ "consent_state", "analytics_permitted" }`.
`false` after a grant (or under the "other" basis) records a withdrawal and erases the visitor's analytics data.

### POST /events
`{ "events": [ { "type": "page_view", "uid": "16–32 alnum", "path": "/x", "title"?, "referrer"?, "ts"?: epoch-ms } ] }` (≤ 20).
Returns `202 { "accepted": bool, "stored": n, "skipped": n }`. `accepted: false` means analytics are not permitted and nothing was stored. Duplicate `uid`s are skipped. Query strings/fragments are stripped; excluded paths are dropped.

---

## 2. WordPress integration API

Base: `/api/v1/integration`. Header `Authorization: Bearer spk_<prefix>.<secret>` (except `pair`). The website is derived from the credential; any website/workspace IDs in requests are ignored.

| Method & path | Body | Response |
|---|---|---|
| `POST /pair` (no auth, rate-limited) | `{ pairing_code, site_url, plugin_version?, wp_version? }` | `{ credential, website: { public_key, name, origin }, endpoints }` — `site_url`'s origin must match the registered origin (`400 origin_mismatch`) |
| `GET /config` | — | `{ website, rotation_requested, widget, tracking, polling, endpoints }` |
| `POST /heartbeat` | `{ plugin_version?, wp_version? }` | `{ status, rotation_requested }` |
| `POST /rotate` | — | `{ credential, grace_seconds: 600 }` — not allowed with a superseded credential |
| `POST /disconnect` | — | `{ disconnected: true, data_retained: true }` |
| `PUT /settings` | `{ widget?: {…}, tracking?: { excluded_paths?, consent_source? } }` | same as `/config` |

Plugin-editable widget fields: `enabled, brand_name, primary_color, position, offset_px, launcher_label, greeting_title, welcome_message, prechat_name, prechat_email, prechat_phone, prechat_notice, hidden_paths`. Analytics policy, legal basis, retention, reopening and blocking policy are dashboard-only.

---

## 3. Dashboard API

Base: `/api/v1/dashboard/w/{workspaceId}`. Session cookie required; writes require `X-CSRF-Token` (the page's CSRF token). Same-origin only (no CORS).

| Method & path | Notes |
|---|---|
| `GET /conversations?status=&website=&q=&unread=1&before=&since=&limit=` | Newest first. `before` = pagination cursor (`next_before` from the previous page); `since` = return only conversations with messages newer than this message ID (polling). `q` searches visitor name/email/ID and message text within this workspace. |
| `GET /conversations/{id}` | Conversation, last 50 messages, visitor panel (`submitted`, `observed`, `inferred`, `consent`, `blocked`), permissions. |
| `GET /conversations/{id}/messages?after=&before=` | Incremental (`after`) or older history (`before`). |
| `POST /conversations/{id}/messages` | `{ client_message_id, body }`, idempotent like the widget. |
| `POST /conversations/{id}/status` | `{ status: open|pending|closed }` |
| `POST /conversations/{id}/read` | `{ message_id }` — clamped to the conversation's last message. |
| `GET /live` | `{ active_window_seconds, recent_window_minutes, items: [{ state: active|recent, last_page (only with analytics permission), country (estimated), … }] }` |

HTML routes (forms) cover websites, settings, members, invitations, blocks, privacy, export and deletion; see `central/routes.php`.

---

## 4. Health

`GET /api/v1/health` → `{ status: ok|degraded, database: ok|unavailable }`. Reveals no versions.

## 5. Versioning and transport

The API is versioned in the path. Live updates use short polling with
incremental cursors; clients back off exponentially on errors and poll less
often in hidden tabs. Server-side message creation calls a
`Chat\Transport\MessageNotifier` (no-op `PollingNotifier` today) so a push
transport (WebSockets, queue workers) can be added without changing the
messaging code.
