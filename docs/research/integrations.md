# Integrations reference: work intake and status write-back

Compiled 2026-10-30 for a self-hosted Node 25 / TypeScript service on macOS. The service is reachable through a Cloudflare tunnel, but every source below also works outbound-only, by polling or WebSocket.

**Legend.** **[V]** means I checked it on 2026-10-30 against the vendor's official docs, OpenAPI spec, GraphQL schema, or package source. **[U]** means it is unverified, inferred, from a secondary source, or the docs conflict, so test it before relying on it. Unmarked statements are long-standing documented behavior or my design advice.

**Code.** I type-checked every TypeScript block with TypeScript 7.0.2 and `@types/node` 26 (`strict`, `erasableSyntaxOnly`, `allowImportingTsExtensions`), so the blocks run directly with `node file.ts` on Node 25 (type stripping). `fetch` and `WebSocket` are globals in Node 25. I also ran the poller, cron catch-up, SQLite and webhook-HMAC snippets. Package versions as of today: `@slack/socket-mode` 3.1.1, `@slack/web-api` 8.3.0, `@slack/bolt` 5.1.0, `croner` 11.0.0, `@linear/sdk` 100.0.0, `jira.js` 6.4.0, `@octokit/rest` 22.0.1, `googleapis` 189.0.0, `gh` 2.87.3.

---

## 0. Decisions at a glance

| Source | Primary intake (no inbound URL) | Optional push (via tunnel) | Status write-back | Approval UX |
|---|---|---|---|---|
| Slack | **Socket Mode** (outbound WSS) | Events API (HTTPS) | Thread reply (`chat.postMessage` + `thread_ts`), edit one status message (`chat.update`), reactions | Block Kit buttons (these work over Socket Mode) |
| Jira Cloud | **JQL poll** on `POST /rest/api/3/search/jql` every 60 s | Admin webhook with secret | ADF comment edited in place, label, transition, issue property | `/approve` comment (polled), or a workflow transition |
| GitHub | **REST poll with ETags** (304s are free) | Repo/App webhook | Issue/PR comment edited in place, reactions, commit status (check runs need an App) | `/approve` comment, reaction on the bot comment, or a PR review |
| Linear | **GraphQL poll** on `updatedAt` | Webhooks; the Agents API (in practice webhook-only) | `commentCreate` (threads via `parentId`) + `commentUpdate`, workflow state, reactions | Reply comment; agent `elicitation` |
| Gmail | **`history.list` poll** on a label | Pub/Sub **pull** (also needs no inbound URL) | Reply in the thread (`messages.send` with `threadId`) | Reply email |
| Monitors / stats | Poll loop + `croner` | Vendor webhooks (Sentry, etc.) | Opens or updates a ticket in a tracker | n/a |
| Manual form | Local HTTP form (bind to 127.0.0.1, or put it behind Cloudflare Access) | n/a | Web page / SSE | Buttons |

**Cross-cutting rules**

1. **Treat a webhook as a hint, not as data.** When a webhook arrives, verify it, ack it, and enqueue "re-fetch entity X now" into the same code path the poller uses. You then have one normalization path, webhooks become a pure latency optimization, and a missed webhook costs nothing because the next poll catches it.
2. **One idempotent intake pipeline.** Normalize, dedupe on `(source, external_id, version)`, then upsert `work_items` with UNIQUE `(source, external_id)`. Delivery is at-least-once, and processing is idempotent.
3. **One living status message per request**, edited in place. Post separate replies only for events that should notify someone: approval needed, PR opened, blocked, failed, done.
4. **Prefer permissioned triggers.** A label, an assignment to the bot, or an allowlisted user's mention or emoji beats free text. Applying a label needs triage/edit rights in GitHub and Jira, so a label gives you an authorization check for free.

---

## 1. Slack

### 1.1 Intake options

| | Socket Mode | Events API (HTTPS) | Polling `conversations.history` |
|---|---|---|---|
| Inbound URL | None. You open a WSS from your side. | Public HTTPS Request URL(s) | None |
| Tokens | App-level `xapp-` (scope `connections:write`) + bot `xoxb-` | Bot `xoxb-` + signing secret | Bot `xoxb-` |
| Gets events / slash commands / button clicks | Yes / yes / yes (one socket) [V] | Yes / yes / yes (separate Request URLs per feature) | Messages only. No slash commands, no button clicks. Reactions only by reading each message's `reactions` array. |
| Latency | Real-time | Real-time | Polling interval |
| Ack rule | Send `{"envelope_id"}` back over the socket immediately | Return 2xx within **3 s** [V] | n/a |
| Marketplace | Socket Mode apps **can't be listed** in the Slack Marketplace [V]. That doesn't matter for an internal app. | Allowed | n/a |
| Failure mode | Socket drops. Reconnect loop. Unacked events are retried by Slack, then dropped. | Retries up to 3x (immediate, +1 min, +5 min) [V]. Subscriptions are auto-disabled if >95% of deliveries fail over 60 min (only for apps receiving ≥1,000 events/h) [V]. | Rate limits (see 1.2) |

**Recommendation.** Use Socket Mode as the primary channel. On startup, do a bounded `conversations.history` backfill per watched channel from the last-seen `ts`, to cover downtime longer than Slack's retry window. Use the Events API only if you later need horizontal scale or the Marketplace.

Events API details, in case you use it [V]:
- Envelope: `{token, team_id, api_app_id, event: {...}, type: "event_callback", event_id, event_time, authorizations, event_context}`. `event_id` is globally unique, so dedupe on it.
- Retry headers are `x-slack-retry-num` (1–3) and `x-slack-retry-reason` (e.g. `http_timeout`). Reply with the header `x-slack-no-retry: 1` to suppress retries.
- Delivery cap: 30,000 events per workspace per app per 60 min. Above that you receive an `app_rate_limited` event.
- When you set the Request URL, Slack POSTs `{"type":"url_verification","challenge":"..."}`. Respond 200 with the `challenge` value (as plain text or `{"challenge": "..."}`). The page I fetched mentions this step without showing the payload, so the exact shape is [U].
- Interactivity and slash commands arrive as `application/x-www-form-urlencoded`. Interactivity puts JSON in a `payload` field. Ack with 200 within 3 s [V].

### 1.2 Rate limits, including the 2025 change

- Web API tiers apply per method, per workspace, per app: Tier 1 is 1+/min, Tier 2 20+/min, Tier 3 50+/min, Tier 4 100+/min, plus "Special" [V]. Exceeding one returns HTTP 429 with `Retry-After` in seconds. Other methods aren't affected [V].
- `chat.postMessage`: about 1 message/s per channel, with short bursts allowed. There is a workspace-wide cap of "several hundred messages per minute" [V].
- `chat.update` and `reactions.add` are Tier 3. `chat.startStream` is Tier 2. `apps.connections.open` is Tier 3 [V].
- **2025 change (changelog dated 2025-05-29) [V].** For **commercially distributed apps not approved for the Slack Marketplace**, `conversations.history` and `conversations.replies` moved from Tier 3 to **Tier 1 (1 request/minute)**, and the `limit` parameter's maximum and default dropped to **15**. The change applied immediately to unlisted apps created on or after 2025-05-29 and to *new installations* of existing unlisted apps. **Internal customer-built apps are unaffected**: 50+ requests/min, with `limit` up to 1,000 (the method reference says max 999 [V], a minor doc inconsistency). Marketplace apps are unaffected.
- **Existing installations of unlisted apps: [U], the sources conflict.** The English changelog I fetched today says existing installs "will not be impacted". Search snippets of revised versions show a cut-over date of 2025-09-02, later changed to **2026-03-03**. If you ever distribute this app to another workspace, assume 1/min with 15 objects.
- **Implication.** Create the app in your own workspace and install it only there. As an internal app it keeps Tier 3, which makes a 60 s backfill poll of a few channels trivially safe.

### 1.3 Tokens and scopes

| Scope (bot) | Needed for |
|---|---|
| `app_mentions:read` | `app_mention` events [V] |
| `channels:history` (+ `groups:history` for private channels) | `message.channels` / `message.groups` events (thread follow-ups without an @mention); `conversations.history` / `conversations.replies` [V] |
| `im:history` (+ `mpim:history` for group DMs) | `message.im` (DMs to the bot); DM history [V] |
| `chat:write` | `chat.postMessage`, `chat.update`, `chat.startStream` [V] |
| `chat:write.public` (optional) | Posting in public channels the bot hasn't joined [V] |
| `reactions:write` | `reactions.add` / `reactions.remove` [V] |
| **`reactions:read`** | **`reaction_added` events** [V]. It's missing from your list but required for emoji triggers. |
| `commands` | Slash commands |
| `users:read` (optional) | Resolving user names and `is_bot` for allowlists |

The **app-level token** (`xapp-…`) is created in app settings under *Basic Information → App-Level Tokens* with scope `connections:write` [V]. A manifest can't create it. `apps.connections.open` itself needs no OAuth scope and only accepts the token in the `Authorization` header, not as a parameter [V].

### 1.4 App manifest (JSON)

```json
{
  "_metadata": { "major_version": 2, "minor_version": 1 },
  "display_information": {
    "name": "Software Factory",
    "description": "Turns requests into PRs and reports back in-thread.",
    "background_color": "#1f2937"
  },
  "features": {
    "app_home": { "home_tab_enabled": false, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
    "bot_user": { "display_name": "factory", "always_online": true },
    "slash_commands": [
      { "command": "/factory", "description": "Submit a work request", "usage_hint": "[describe the change]", "should_escape": false }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read", "channels:history", "groups:history", "im:history",
        "chat:write", "reactions:read", "reactions:write", "commands", "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["app_mention", "message.im", "message.channels", "message.groups", "reaction_added"]
    },
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

Notes [V, from the manifest reference]:
- `slash_commands[].url`, `event_subscriptions.request_url` and `interactivity.request_url` are optional. Leave them out for Socket Mode. Without Socket Mode, manifest validation fails with "Event Subscription requires either Request URL or Socket Mode Enabled".
- Limits: `display_information.name` ≤35 chars. `bot_user.display_name` ≤80 chars, `[a-z0-9-_.]`. `command` ≤32 chars including `/`. At most 50 commands and 100 bot events.
- Drop `message.channels` / `message.groups` if you don't need un-mentioned thread follow-ups. They deliver *every* message in every channel the bot belongs to.
- `messages_tab_enabled: true` lets users DM the bot.

### 1.5 Detecting triggers

**Mention** (`app_mention`) [V]:
```json
{ "type": "event_callback", "event_id": "Ev123ABC456", "event_time": 1515449522,
  "event": { "type": "app_mention", "user": "U123ABC456", "text": "<@U0LAN0Z89> add rate limiting to /export",
             "ts": "1515449522.000016", "channel": "C123ABC456", "event_ts": "1515449522.000016" } }
```
- The event isn't sent for DMs; use `message.im` for those. It only fires in conversations the bot is a member of. Inviting the bot via a mention also produces an `app_mention` [V].
- A mention inside a thread carries `thread_ts`. The page doesn't document this field in its examples [U], but it's present in practice.
- If you subscribe to `message.channels`, the same message arrives twice: once as `app_mention` and once as `message`. Dedupe on `channel + ts`.

**DM**: a `message` event with `channel_type: "im"`. **Ignore** anything with `bot_id` or any `subtype` (`message_changed`, `message_deleted`, `bot_message`, …). Otherwise the bot can loop on its own posts.

**Slash command**: a `slash_commands` envelope whose payload has `token, team_id, team_domain, channel_id, channel_name, user_id, user_name, command, text, response_url, trigger_id` [V]. Your ack may carry a response payload (`accepts_response_payload: true`), which is shown to the invoker, e.g. `{ "response_type": "ephemeral", "text": "Queued." }`. To post in a channel, the bot must be a member or have `chat:write.public`.

**Emoji reaction** (`reaction_added`, needs `reactions:read`) [V]:
```json
{ "event": { "type": "reaction_added", "user": "U123ABC456", "reaction": "robot_face", "item_user": "U222222222",
             "item": { "type": "message", "channel": "C123ABC456", "ts": "1360782400.498405" },
             "event_ts": "1360782804.083113" } }
```
The event doesn't include the message text. Fetch it with `conversations.history` (`channel`, `oldest=latest=item.ts`, `inclusive=true`, `limit=1`) for top-level messages. Use `conversations.replies` (`ts=item.ts`) if it may be a thread reply. The replies variant returning a single reply when given a reply `ts` is [U]. Authorize the **reactor** (`event.user`), not the message author.

**Thread follow-up**: a `message` event whose `thread_ts` matches an active work item's thread. Feed it to the run as a `followup` event.

### 1.6 Threads and status updates

- `chat.postMessage` [V]: `channel`, `text`, `blocks`, `thread_ts` (the parent `ts`), `reply_broadcast` (also show the reply in the channel), `unfurl_links`, `metadata` (`{event_type, event_payload}`), and `markdown_text` (≤12,000 chars, can't be combined with `text`/`blocks`). The response is `{ok, channel, ts, message}`. Store `channel + ts`. Keep `text` as a fallback whenever you send `blocks`, because notifications and screen readers use it [V].
- `chat.update` [V]: `channel`, `ts`, `text`, `blocks` (send `[]` to clear), `markdown_text`, `reply_broadcast`. A bot can only edit its own messages, and ephemeral messages can't be edited. Sending `text` without `blocks` **removes** existing blocks.
- `reactions.add` [V]: `channel`, `name` (without colons), `timestamp`. The error `already_reacted` is safe to ignore. Pattern: `eyes` on pickup, swap to `white_check_mark` or `x` at the end (via `reactions.remove`).
- **Crash-safe dedupe of your own posts.** Put `metadata: {event_type: "factory_status", event_payload: {run_id}}` on status messages. After a crash, read the thread with `include_all_metadata=true` [V, argument exists] to find the existing message instead of posting a duplicate.
- **Streaming (optional)** [V]: `chat.startStream` → `chat.appendStream` → `chat.stopStream` (scope `chat:write`, Tier 2). It needs `thread_ts` except in special session channels. `recipient_user_id` and `recipient_team_id` are required in channels. A stream lasts at most 10 minutes and holds ≤12,000 chars of markdown. Good for "live log" progress; use `chat.update` for long runs.
- Escape `&`, `<`, `>` in any user or ticket text you echo back, and never echo `<!channel>`, `<!here>` or `<!subteam^…>`.

### 1.7 Approve/Reject buttons (works the same over Socket Mode)

The blocks the bot posts are produced by `approvalBlocks()` in §1.9. A click delivers a `block_actions` payload (trimmed) [V]:
```json
{ "type": "block_actions",
  "user": { "id": "UA8RXUSPL", "username": "jtorrance", "team_id": "T9TK3CUKW" },
  "api_app_id": "AABA1ABCD", "trigger_id": "123.456.abc",
  "container": { "type": "message", "message_ts": "1548261231.000200", "channel_id": "CBR2V3XEX", "is_ephemeral": false },
  "channel": { "id": "CBR2V3XEX", "name": "eng-requests" },
  "message": { "ts": "1548261231.000200", "text": "...", "blocks": [] },
  "response_url": "https://hooks.slack.com/actions/AABA1ABCD/1232321423432/D09sSasdasdAS9091209",
  "actions": [ { "type": "button", "action_id": "factory_approve", "block_id": "approval:wi_123",
                 "value": "wi_123", "action_ts": "1548426417.840180" } ] }
```
- **Over HTTP** the payload arrives as a form-encoded `payload=<json>`; ack with 200 within 3 s [V]. **Over Socket Mode** it arrives as an `interactive` envelope; ack with `{"envelope_id"}`.
- Update the original message with `chat.update(container.channel_id, container.message_ts)`, or POST to `response_url` with `{"replace_original": true, ...}`. `response_url` works up to 5 times within 30 minutes [V].
- Security: check `user.id` against the approvers. Treat `value` as an opaque one-time `approvalId` and transition its DB row atomically from `pending` to `decided`, so duplicate clicks are no-ops. Expire stale approvals. Don't trust `message` content in the payload.

### 1.8 Socket Mode wire protocol (for a no-SDK client) [V unless marked]

1. `POST https://slack.com/api/apps.connections.open` with `Authorization: Bearer xapp-…` returns `{"ok": true, "url": "wss://wss-….slack.com/link/?ticket=…&app_id=…"}`. Every connection needs a fresh URL. Append `&debug_reconnects=true` to get 360 s connections for testing.
2. The server first sends:
   ```json
   { "type": "hello", "num_connections": 1,
     "connection_info": { "app_id": "A123" },
     "debug_info": { "host": "applink-…", "started": "…", "build_number": 10, "approximate_connection_time": 18060 } }
   ```
3. Each delivery is an envelope:
   ```json
   { "envelope_id": "57d6a792-4d35-4d0b-b6aa-3361493e1caf", "type": "events_api",
     "accepts_response_payload": false, "retry_attempt": 0, "retry_reason": "",
     "payload": { "type": "event_callback", "event_id": "Ev…", "event": { "type": "app_mention", "…": "…" } } }
   ```
   `type` is one of `events_api`, `interactive`, `slash_commands`. The `retry_attempt` / `retry_reason` fields are seen in the `@slack/socket-mode` source; the docs page doesn't document them.
4. Ack by sending `{"envelope_id": "…"}`, optionally with `"payload": {...}` when `accepts_response_payload` is true.
5. Disconnects: `{"type": "disconnect", "reason": "warning" | "refresh_requested" | "link_disabled", "debug_info": {"host": "…"}}`. `warning` comes about 10 s before the disconnect. `refresh_requested` can arrive with no warning. `link_disabled` means Socket Mode was turned off. Reconnect by calling `apps.connections.open` again. You may hold up to **10** concurrent connections, and Slack may deliver to any of them.
6. Liveness: Slack sends WebSocket **ping frames**. Node's global `WebSocket` auto-responds but doesn't expose pings, so the raw client can't detect a half-open TCP connection. It mitigates this by recycling the connection near `approximate_connection_time`. For ping-based liveness, use the `ws` package (`ws.on('ping')`) or `@slack/socket-mode`, whose defaults are `serverPingTimeout` 30,000 ms and `clientPingTimeout` 5,000 ms [V, package source]. The ack deadline for Socket Mode isn't stated on the Socket Mode page; assume the same 3 s as HTTP [U].

### 1.9 Minimal Socket Mode client without any SDK

```ts
// slack-raw.ts: zero-dependency Slack Socket Mode client + Web API helper.
// Node >= 22 (global WebSocket + fetch). Runs directly with `node slack-raw.ts` on Node 25 (type stripping).
const APP_TOKEN = process.env.SLACK_APP_TOKEN ?? ''; // xapp-... (scope: connections:write)
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''; // xoxb-...

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Call any Web API method. Form-encoding works for every method; objects (blocks, metadata) are JSON-stringified. */
export async function slackApi<T = Record<string, any>>(
  method: string,
  args: Record<string, unknown> = {},
  token: string = BOT_TOKEN,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(Number(res.headers.get('retry-after') ?? '1') * 1000);
      continue;
    }
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new Error(`slack ${method} failed: ${json.error}`);
    return json;
  }
}

export type SocketEnvelope = {
  envelope_id: string;
  type: 'events_api' | 'interactive' | 'slash_commands';
  payload: any;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
};

export type EnvelopeHandler = (env: SocketEnvelope) => Promise<void>;

/** Minimal Socket Mode client: connect, ack every envelope immediately, hand off to handler, reconnect forever. */
export function startSocketMode(handler: EnvelopeHandler, opts: { onAck?: (env: SocketEnvelope) => unknown } = {}) {
  let stopped = false;
  let current: WebSocket | undefined;

  async function connectOnce(): Promise<void> {
    const { url } = await slackApi<{ url: string }>('apps.connections.open', {}, APP_TOKEN);
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url); // append '&debug_reconnects=true' to url to test reconnects (360 s connections)
      current = ws;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'hello') {
          // Proactively recycle shortly before Slack's estimated refresh, in case the disconnect frame is missed.
          const secs = Number(msg.debug_info?.approximate_connection_time ?? 3600);
          refreshTimer = setTimeout(() => ws.close(), Math.max(60, secs - 30) * 1000);
          return;
        }
        if (msg.type === 'disconnect') {
          // reason: 'warning' | 'refresh_requested' | 'link_disabled'
          ws.close();
          return;
        }
        if (typeof msg.envelope_id !== 'string') return;
        const env = msg as SocketEnvelope;
        // 1) Ack first (Slack expects an ack within ~3 s or it retries / shows an error to the user).
        const ackPayload = env.accepts_response_payload ? opts.onAck?.(env) : undefined;
        ws.send(JSON.stringify(ackPayload ? { envelope_id: env.envelope_id, payload: ackPayload } : { envelope_id: env.envelope_id }));
        // 2) Do the real work asynchronously.
        handler(env).catch((err) => console.error('[slack] handler error', err));
      });
      ws.addEventListener('close', () => {
        clearTimeout(refreshTimer);
        resolve();
      });
      ws.addEventListener('error', (ev) => console.error('[slack] websocket error', (ev as ErrorEvent).message ?? ev.type));
    });
  }

  void (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        await connectOnce();
        failures = 0;
      } catch (err) {
        failures++;
        console.error('[slack] connect failed', err);
      }
      if (!stopped) await sleep(Math.min(60_000, 500 * 2 ** failures) * (0.5 + Math.random()));
    }
  })();

  return {
    stop() {
      stopped = true;
      current?.close();
    },
  };
}
```

Router for mentions, DMs, reactions, slash commands and approval buttons (uses the client above):

```ts
// slack-app.ts: routing mentions, DMs, reactions, slash commands and approval buttons.
import { slackApi, startSocketMode, type SocketEnvelope } from './slack-raw.ts';

const TRIGGER_EMOJI = 'robot_face';
const ALLOWED_USERS = new Set((process.env.SLACK_ALLOWED_USERS ?? '').split(',').filter(Boolean));
const seenEventIds = new Set<string>(); // use the DB-backed `seen` table in production

declare function enqueueWorkRequest(req: {
  source: 'slack'; externalId: string; text: string; requestedBy: string;
  conversation: { channel: string; threadTs: string; statusTs: string };
}): Promise<string>; // returns workItemId
declare function recordApproval(workItemId: string, decision: 'approve' | 'reject', by: string): Promise<boolean>;

export function approvalBlocks(workItemId: string, summary: string) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    {
      type: 'actions',
      block_id: `approval:${workItemId}`,
      elements: [
        { type: 'button', action_id: 'factory_approve', style: 'primary', value: workItemId,
          text: { type: 'plain_text', text: 'Approve' } },
        { type: 'button', action_id: 'factory_reject', style: 'danger', value: workItemId,
          text: { type: 'plain_text', text: 'Reject' },
          confirm: {
            title: { type: 'plain_text', text: 'Reject this plan?' },
            text: { type: 'plain_text', text: 'The run will be cancelled.' },
            confirm: { type: 'plain_text', text: 'Reject' },
            deny: { type: 'plain_text', text: 'Keep' },
          } },
      ],
    },
  ];
}

async function intake(channel: string, ts: string, threadTs: string | undefined, user: string, text: string) {
  if (ALLOWED_USERS.size && !ALLOWED_USERS.has(user)) return;
  const root = threadTs ?? ts; // reply in the existing thread, or start one under the message
  await slackApi('reactions.add', { channel, name: 'eyes', timestamp: ts }).catch(() => {}); // already_reacted is fine
  const status = await slackApi<{ ts: string }>('chat.postMessage', {
    channel, thread_ts: root, text: 'Picked up. Planning...',
    metadata: { event_type: 'factory_status', event_payload: { source_ts: ts } },
  });
  await enqueueWorkRequest({
    source: 'slack', externalId: `${channel}:${ts}`, text, requestedBy: user,
    conversation: { channel, threadTs: root, statusTs: status.ts },
  });
}

async function onEnvelope(env: SocketEnvelope) {
  if (env.type === 'events_api') {
    const { event_id, event: e } = env.payload;
    if (seenEventIds.has(event_id)) return; // retries carry the same event_id
    seenEventIds.add(event_id);

    if (e.type === 'app_mention') {
      return intake(e.channel, e.ts, e.thread_ts, e.user, e.text);
    }
    if (e.type === 'message' && e.channel_type === 'im' && !e.bot_id && !e.subtype) {
      return intake(e.channel, e.ts, e.thread_ts, e.user, e.text);
    }
    if (e.type === 'reaction_added' && e.reaction === TRIGGER_EMOJI && e.item?.type === 'message') {
      // Fetch the reacted-to message (works for top-level and thread replies; see notes).
      const r = await slackApi<{ messages: any[] }>('conversations.replies', {
        channel: e.item.channel, ts: e.item.ts, latest: e.item.ts, inclusive: true, limit: 1,
      });
      const m = r.messages.find((x) => x.ts === e.item.ts) ?? r.messages[0];
      if (m) return intake(e.item.channel, m.ts, m.thread_ts, e.user, m.text ?? '');
    }
    return;
  }

  if (env.type === 'slash_commands') {
    const p = env.payload; // { command, text, user_id, channel_id, response_url, trigger_id, ... }
    if (p.command === '/factory') {
      const root = await slackApi<{ ts: string }>('chat.postMessage', {
        channel: p.channel_id, text: `<@${p.user_id}> requested: ${p.text}`,
      });
      return intake(p.channel_id, root.ts, undefined, p.user_id, p.text);
    }
    return;
  }

  if (env.type === 'interactive' && env.payload.type === 'block_actions') {
    const p = env.payload;
    const action = p.actions?.[0];
    if (!action || !['factory_approve', 'factory_reject'].includes(action.action_id)) return;
    const decision = action.action_id === 'factory_approve' ? 'approve' : 'reject';
    if (ALLOWED_USERS.size && !ALLOWED_USERS.has(p.user.id)) {
      await slackApi('chat.postEphemeral', { channel: p.container.channel_id, user: p.user.id, text: 'You are not an approver.' });
      return;
    }
    const accepted = await recordApproval(action.value, decision, p.user.id); // false if already decided/expired
    if (!accepted) return;
    await slackApi('chat.update', {
      channel: p.container.channel_id,
      ts: p.container.message_ts,
      text: `${decision === 'approve' ? 'Approved' : 'Rejected'} by <@${p.user.id}>`,
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn',
        text: `${decision === 'approve' ? ':white_check_mark: Approved' : ':x: Rejected'} by <@${p.user.id}>` }] }],
    });
  }
}

startSocketMode(onEnvelope, {
  // Slash commands accept an ack payload: shown ephemerally to the invoking user.
  onAck: (env) => (env.type === 'slash_commands' ? { response_type: 'ephemeral', text: 'Queued.' } : undefined),
});
```

### 1.10 Same thing with `@slack/socket-mode` (no Bolt)

`SocketModeClient` re-emits `events_api` envelopes under the **inner event type** (`app_mention`, `message`, `reaction_added`) and everything else under the **envelope type** (`interactive`, `slash_commands`). It also emits a catch-all `slack_event`. Listener args are `{ack, envelope_id, body, event, retry_num, retry_reason, accepts_response_payload}`. Constructor options: `appToken`, `logLevel`, `logger`, `autoReconnectEnabled` (default true), `clientPingTimeout` (default 5,000 ms), `serverPingTimeout` (default 30,000 ms), `pingPongLoggingEnabled`, `clientOptions` [V, from the 3.1.1 source]. Use Bolt only if you want its middleware and router. Socket Mode itself doesn't need it.

```ts
// slack-sdk.ts: same intake using the official low-level packages (no Bolt).
// npm i @slack/socket-mode @slack/web-api
import { SocketModeClient, LogLevel } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

const web = new WebClient(process.env.SLACK_BOT_TOKEN);           // xoxb-
const socket = new SocketModeClient({
  appToken: process.env.SLACK_APP_TOKEN ?? '',                    // xapp- with connections:write
  logLevel: LogLevel.INFO,
  // defaults: autoReconnectEnabled true, clientPingTimeout 5000 ms, serverPingTimeout 30000 ms
});

// events_api envelopes are re-emitted under the inner event type.
socket.on('app_mention', async ({ event, body, ack, retry_num }) => {
  await ack();                                                    // ack first
  if (retry_num) return;                                          // or dedupe on body.event_id
  await web.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts });
  await web.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts ?? event.ts, text: 'Picked up.' });
  void body;
});

socket.on('reaction_added', async ({ event, ack }) => {
  await ack();
  if (event.reaction !== 'robot_face') return;
  // ... same as raw example
});

// Non-events_api envelopes are emitted under the envelope type.
socket.on('slash_commands', async ({ body, ack }) => {
  await ack({ response_type: 'ephemeral', text: `Queued: ${body.text}` });
});

socket.on('interactive', async ({ body, ack }) => {
  await ack();
  if (body.type !== 'block_actions') return;
  const action = body.actions[0];
  await web.chat.update({
    channel: body.container.channel_id,
    ts: body.container.message_ts,
    text: `${action.action_id === 'factory_approve' ? 'Approved' : 'Rejected'} by <@${body.user.id}>`,
    blocks: [],
  });
});

socket.on('disconnected', (err?: Error) => console.warn('socket disconnected', err?.message));
await socket.start();
```

### 1.11 Events API over HTTPS (if you use the tunnel)

Verify **before** parsing [V]. Read the raw body bytes, compute `v0=` + hex(HMAC-SHA256(signing_secret, "v0:" + X-Slack-Request-Timestamp + ":" + raw_body)), and constant-time compare it to `X-Slack-Signature`. Reject timestamps more than 5 minutes off. The implementation is `verify.slack()` in §9.1. Then answer `url_verification`, ack 200 immediately, and process asynchronously.

### 1.12 Polling and backfill with `conversations.history`

- Arguments: `channel`, `oldest` (exclusive unless `inclusive=true`), `latest`, `limit` (default 100, max 999 for internal apps), `cursor`, `include_all_metadata`. The response is `{messages[], has_more, response_metadata.next_cursor}`, newest first [V].
- Algorithm per channel: `oldest = last_seen_ts`. Page until `has_more` is false, process oldest→newest, and set `last_seen_ts = max(ts)`. Thread replies aren't in `history`: for each message with `reply_count > 0` and `latest_reply > last_seen`, call `conversations.replies`. Detect `:robot_face:` triggers by inspecting `message.reactions[]` (`name`, `users`, `count`).
- Use it for startup backfill and as a degraded mode, not as the main intake.

---

## 2. Jira Cloud

### 2.1 Auth options

| Option | How | Pros | Cons |
|---|---|---|---|
| **Classic API token** (recommended to start) | `Authorization: Basic base64(email:token)` against `https://<site>.atlassian.net` [V] | Simplest. Not subject to the 2026 points-based quotas, only burst limits [V]. | Acts as a real user, so use a dedicated bot account. Tokens expire after 1–365 days (default 1 year) [V]. A CAPTCHA triggered by failed logins blocks basic auth (`X-Seraph-LoginReason: AUTHENTICATION_DENIED`) [V]. |
| **Scoped API token** | Same Basic header, but requests **must** go to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…` [V, via an Atlassian support doc] | Least privilege, e.g. `read:jira-work` and `write:jira-work` only | Needs the `cloudId`, e.g. from `https://<site>.atlassian.net/_edge/tenant_info` [U]. A scoped token against the site URL returns 401 [U, community report]. |
| **OAuth 2.0 (3LO)** | Authorize at `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=…&scope=…&redirect_uri=…&state=…&response_type=code&prompt=consent`. Exchange at `POST https://auth.atlassian.com/oauth/token`. Find sites via `GET https://api.atlassian.com/oauth/token/accessible-resources`. Call `https://api.atlassian.com/ex/jira/{cloudid}/…` [V] | Per-user attribution, multi-site, can register **dynamic webhooks** | Redirect URI and consent flow. Refresh tokens **rotate**: each refresh disables the old one, they expire after 90 days of inactivity, and there is a 10-minute reuse leeway [V]. Subject to the points-based quota (65k points/h global pool by default, enforced since 2026-03-02) [V]. |
| **Forge** | An app hosted by Atlassian, with product-event triggers and Forge Remote to reach your backend [U, not deep-verified] | Native UI (issue panels), runs inside Atlassian | You build and deploy a Forge app. Pushing to your service still needs a reachable endpoint. Overkill for a single-site private service. |

Typical 3LO scopes: `read:jira-work write:jira-work read:jira-user manage:jira-webhook offline_access` (`offline_access` returns a refresh token) [V]. Persist a rotated refresh token **before** you use the new access token; if you lose it, the user must re-authorize.

### 2.2 Searching: `/rest/api/3/search/jql` (the old `/search` is gone)

- **Deprecated:** `GET|POST /rest/api/3/search` (also `/rest/api/2/search` and `POST /search/id`). The OpenAPI spec says: "Endpoint is currently being removed" (changelog **CHANGE-2046**) [V]. Clients report **HTTP 410 Gone** with "Please migrate to /rest/api/3/search/jql". Removal was phased by region through 2025; the exact final date is [U].
- **Use:** `GET /rest/api/3/search/jql` (query params) or **`POST /rest/api/3/search/jql`** (JSON body, for long JQL) [V]:

```json
POST /rest/api/3/search/jql
{
  "jql": "project = ENG AND labels = \"factory\" AND statusCategory = \"To Do\" AND updated >= -5m ORDER BY updated ASC",
  "fields": ["summary", "description", "labels", "status", "updated", "reporter", "assignee"],
  "maxResults": 100,
  "nextPageToken": null,
  "properties": ["software-factory"],
  "expand": "renderedFields",
  "fieldsByKeys": false,
  "failFast": false,
  "reconcileIssues": []
}
```

```json
200 OK
{
  "issues": [
    { "id": "10042", "key": "ENG-42", "self": "https://<site>.atlassian.net/rest/api/3/issue/10042",
      "fields": { "summary": "…", "description": { "type": "doc", "version": 1, "content": [] },
                  "labels": ["factory"], "updated": "2026-10-30T14:03:11.123+0000",
                  "status": { "name": "To Do", "statusCategory": { "key": "new", "name": "To Do" } } } }
  ],
  "nextPageToken": "CAEaAggD",
  "isLast": false
}
```

Rules [V, from the spec]:
- **`fields` defaults to `id` only.** This differs from `GET /issue`, which returns all fields. Always pass `fields`.
- **JQL must be bounded**, i.e. carry a search restriction. `order by key desc` alone is rejected. `ORDER BY` allows at most 7 fields.
- Pagination: send the previous response's `nextPageToken`. The token is absent or null on the last page and expires after 7 days. There is no `total` and no `startAt`. For a count, use `POST /rest/api/3/search/approximate-count {"jql": "…"}` (bounded JQL) [V]. The response shape `{"count": n}` is [U].
- `maxResults` defaults to 50. Jira may return fewer when you request many fields. "It returns max 5000 issues" when requesting only ids or keys.
- `properties`: up to 5 issue property keys. `expand` is a comma-separated **string** here, not an array.
- **Eventual consistency:** "Recent updates might not be immediately visible in the returned search results." Use an overlap window in your cursor (§5). For read-after-write, pass up to 50 ids in `reconcileIssues`.
- Classic OAuth scope: `read:jira-work` (granular: `read:issue-details:jira` and others).

**JQL patterns for intake**
```
project = ENG AND labels = "factory" AND statusCategory = "To Do" AND updated >= -5m ORDER BY updated ASC
project = ENG AND labels = "factory" AND labels not in ("factory-picked") AND updated >= "2026/10/30 14:05" ORDER BY updated ASC
assignee = "<bot accountId>" AND statusCategory != Done AND updated >= "2026/10/30 14:05" ORDER BY updated ASC
```
- `-5m` is relative to query time. That works for a fixed interval, but **use absolute timestamps with an overlap for cursors**, so that downtime gets caught up.
- JQL date literals (`"yyyy/MM/dd HH:mm"`) have **minute** precision and are interpreted in the **API user's profile time zone** (`GET /rest/api/3/myself` returns `timeZone`). The `jqlDate()` helper below handles this. The time-zone behavior is long-standing but I didn't re-verify it today [U].
- `statusCategory` names are `"To Do"` (key `new`), `"In Progress"` (`indeterminate`) and `"Done"` (`done`).
- `labels not in (x)` also excludes issues with **no** labels. That's harmless here because `labels = "factory"` is required anyway. Otherwise write `(labels is EMPTY OR labels not in (x))`.

### 2.3 Reading issue fields, ADF, comments, and who triggered it

- `GET /rest/api/3/issue/{key}?fields=summary,description,labels,status,reporter,assignee,comment,attachment` (defaults to all fields). Add `&expand=renderedFields` to get HTML renderings alongside ADF.
- v3 rich-text fields (`description`, comment `body`, rich-text custom fields) are **ADF** (Atlassian Document Format): `{"type":"doc","version":1,"content":[…]}`. Common nodes are `paragraph`, `text` (with `marks`: `strong`, `em`, `code`, `link{href}`), `hardBreak`, `heading{level}`, `bulletList` / `orderedList` → `listItem`, `codeBlock{language}`, `mention{id,text}`, `inlineCard{url}`, `mediaSingle` → `media` (attachments), `table`, `panel`. Use `adfToText()` below.
- Comments: `GET /rest/api/3/issue/{key}/comment?orderBy=-created&maxResults=50` (paginated by `startAt`) [V]. Each comment has `{id, author{accountId}, body(ADF), created, updated, visibility?}`.
- **Who added the trigger label:** `GET /rest/api/3/issue/{key}/changelog` (paginated, oldest first) [V]. Find `histories[].items[]` with `field: "labels"` whose `toString` contains your label, and check `histories[].author.accountId` against an allowlist.
- `GET /rest/api/3/myself` returns `accountId` (use it to skip your own comments) and `timeZone`.

### 2.4 Adding and editing comments (ADF)

```json
POST /rest/api/3/issue/ENG-42/comment
{
  "body": {
    "type": "doc", "version": 1,
    "content": [
      { "type": "paragraph", "content": [
        { "type": "text", "text": "Status: ", "marks": [{ "type": "strong" }] },
        { "type": "text", "text": "PR opened, waiting for CI." }
      ]},
      { "type": "paragraph", "content": [
        { "type": "text", "text": "octo/app#128", "marks": [{ "type": "link", "attrs": { "href": "https://github.com/octo/app/pull/128" } }] }
      ]}
    ]
  }
}
```
- Returns `201` with `{id, …}`. Permissions are *Browse projects* + *Add comments*. OAuth scope is `write:jira-work` [V].
- Edit in place with `PUT /rest/api/3/issue/{key}/comment/{id}` and the same body shape [V, path]. Optional `"visibility": {"type": "role", "value": "Developers"}` restricts who can see it.
- Text nodes must be non-empty. Use `hardBreak` for line breaks.
- Tag your own comments for crash-safe lookup with `PUT /rest/api/3/comment/{commentId}/properties/software-factory` [V, path].

### 2.5 Transitioning status

```http
GET  /rest/api/3/issue/ENG-42/transitions
→ { "transitions": [ { "id": "21", "name": "Start progress",
                       "to": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } } } ] }
POST /rest/api/3/issue/ENG-42/transitions
{ "transition": { "id": "21" } }            → 204
```
- Workflows differ per project, so **never hard-code transition ids**. Select by the target `statusCategory.key` or status name. Transitions with screens accept `fields` / `update` in the same POST. Use `expand=transitions.fields` to see what's required [V].
- The list is empty if the user lacks the *Transition issues* permission [V].

### 2.6 Marking "picked up" (labels and properties)

- Label: `PUT /rest/api/3/issue/{key}` with `{"update": {"labels": [{"add": "factory-picked"}]}}` (and `{"remove": "…"}`). Labels can't contain spaces. `PUT /issue` ignores transitions [V].
- Structured state: `PUT /rest/api/3/issue/{key}/properties/software-factory` with any JSON up to **32,768 chars**, keys ≤255 chars [V]. Read it back via the search `properties` parameter. Issue properties aren't JQL-searchable unless a Connect or Forge app declares them for indexing [U], so keep **queryable** state in labels and **structured** state (run id, PR URL, status-comment id) in a property.
- Visible signals: assign to the bot account and transition to *In Progress*.
- Batch edits: there is a per-issue write limit of 20 writes / 2 s and 100 writes / 30 s [V]. Combine label and field changes into one `PUT`.

### 2.7 Webhooks (public URL required)

- **Admin webhooks** (Jira Settings → System → WebHooks, or `POST https://<site>.atlassian.net/rest/webhooks/1.0/webhook` with `{name, url, events, filters}`) [V]. Events include `jira:issue_created`, `jira:issue_updated` and `comment_created`. Issue, comment and attachment events take a **JQL filter**. They need admin rights.
- **Secret**: optional, and it can't be retrieved after creation. With a secret set, requests carry `X-Hub-Signature: sha256=<hex HMAC of body>` [V]. See `verify.jira()` in §9.1.
- Headers `X-Atlassian-Webhook-Identifier` (stable across retries, so dedupe on it), `X-Atlassian-Webhook-Retry` and `X-Atlassian-Webhook-Flow` [V].
- **Retries:** up to 5 times with randomized 5–15 min backoff, on 408/409/425/429/5xx and on connection failures or timeouts [V].
- Payload: `{timestamp, webhookEvent, issue_event_type_name, user, issue, changelog?, comment?}`. `changelog` only appears on `jira:issue_updated` [V].
- **Dynamic webhooks** (OAuth 3LO and Connect only): `POST /rest/api/3/webhook` (scope `manage:jira-webhook`). They **expire after 30 days**; extend them with `PUT /rest/api/3/webhook/refresh`. For non-public OAuth apps, delivery only happens if the app owner is the user who registered the webhook [V]. How dynamic-webhook deliveries are signed is [U].

### 2.8 Rate limits [V]

- **Burst** (all auth types): token buckets per tenant and endpoint. Defaults are 100 req/s for GET/POST and 50 req/s for PUT/DELETE; some endpoints are higher (e.g. `GET /issue/{key}` at 150/s).
- **Per-issue writes:** 20 per 2 s and 100 per 30 s.
- **Points-based hourly quotas** (enforced for **Forge, Connect and OAuth 3LO** since **2026-03-02**; **API-token traffic is not affected**). A request costs 1 point plus per-object costs (2 per user, group or permission object); writes cost 1. The default Tier 1 pool is 65,000 points/h, resetting at the top of each UTC hour. Tier 2 (per tenant, after review) runs 100k–500k/h depending on edition.
- 429 headers: `Retry-After` (s), `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (ISO 8601), `X-RateLimit-NearLimit` (true when <20% remains), and `RateLimit-Reason` (`jira-quota-global-based` | `jira-quota-tenant-based` | `jira-burst-based` | `jira-per-issue-on-write`).
- Backoff: honor `Retry-After` as a minimum, back off exponentially with jitter ×0.7–1.3, retry about 4 times, and only for idempotent requests.
- A 60 s JQL poll with one page is about 60 requests/hour, negligible.

### 2.9 Minimal TypeScript: poll, read ADF, comment, label, property, transition

```ts
// jira.ts: Jira Cloud REST v3 poller + write-back with an API token (no SDK).
// Classic token: JIRA_BASE=https://<site>.atlassian.net
// Scoped token:  JIRA_BASE=https://api.atlassian.com/ex/jira/<cloudId>
const JIRA_BASE = process.env.JIRA_BASE ?? '';
const AUTH = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function jira<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(JIRA_BASE + path, {
      method: init.method ?? 'GET',
      headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '5');
      await sleep(retryAfter * 1000 * (0.7 + Math.random() * 0.6)); // Atlassian: honor Retry-After, add jitter
      continue;
    }
    if (!res.ok) throw new Error(`jira ${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

export type JiraIssue = {
  id: string; key: string;
  fields: { summary: string; description: AdfNode | null; labels: string[]; updated: string;
    status: { name: string; statusCategory: { key: 'new' | 'indeterminate' | 'done' } };
    reporter?: { accountId: string; displayName: string } };
};

/** Enhanced search: POST /rest/api/3/search/jql, paginated by nextPageToken (absent on the last page). */
export async function* searchJql(jql: string, fields: string[]): AsyncGenerator<JiraIssue> {
  let nextPageToken: string | undefined;
  do {
    const page = await jira<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>('/rest/api/3/search/jql', {
      method: 'POST',
      body: { jql, fields, maxResults: 100, nextPageToken },   // `fields` defaults to ["id"] if omitted!
    });
    yield* page.issues;
    nextPageToken = page.nextPageToken ?? undefined;
  } while (nextPageToken);
}

/** JQL date literals are minute-precision and interpreted in the *API user's* profile time zone. */
export function jqlDate(d: Date, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

// ---------- ADF helpers ----------
export type AdfNode = { type: string; version?: number; text?: string; content?: AdfNode[]; attrs?: Record<string, any>; marks?: any[] };

export function adfToText(node: AdfNode | null | undefined): string {
  if (!node) return '';
  switch (node.type) {
    case 'text': return node.text ?? '';
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text ?? '@user';
    case 'emoji': return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard': case 'blockCard': return node.attrs?.url ?? '';
    case 'codeBlock': return '```\n' + (node.content ?? []).map(adfToText).join('') + '\n```\n\n';
    case 'listItem': return '- ' + (node.content ?? []).map(adfToText).join('').trim() + '\n';
    case 'paragraph': case 'heading': return (node.content ?? []).map(adfToText).join('') + '\n\n';
    default: return (node.content ?? []).map(adfToText).join('');
  }
}

/** Plain text -> ADF doc. Blank line = new paragraph, single newline = hardBreak. Text nodes must be non-empty. */
export function textToAdf(text: string, link?: { label: string; href: string }): AdfNode {
  const paragraphs: AdfNode[] = text.split(/\n{2,}/).filter((p) => p.trim()).map((p) => ({
    type: 'paragraph',
    content: p.split('\n').flatMap((line, i): AdfNode[] => [
      ...(i > 0 ? [{ type: 'hardBreak' }] : []),
      ...(line ? [{ type: 'text', text: line }] : []),
    ]),
  }));
  if (link) paragraphs.push({ type: 'paragraph', content: [
    { type: 'text', text: link.label, marks: [{ type: 'link', attrs: { href: link.href } }] }] });
  return { type: 'doc', version: 1, content: paragraphs };
}

// ---------- write-back ----------
export const addComment = (key: string, text: string) =>
  jira<{ id: string }>(`/rest/api/3/issue/${key}/comment`, { method: 'POST', body: { body: textToAdf(text) } });

export const updateComment = (key: string, commentId: string, text: string) =>
  jira(`/rest/api/3/issue/${key}/comment/${commentId}`, { method: 'PUT', body: { body: textToAdf(text) } });

export const addLabel = (key: string, label: string) =>
  jira(`/rest/api/3/issue/${key}`, { method: 'PUT', body: { update: { labels: [{ add: label }] } } });
// Append ?notifyUsers=false to suppress watcher emails; that needs Administer Jira / Administer Projects.

export const setProperty = (key: string, prop: string, value: unknown) =>
  jira(`/rest/api/3/issue/${key}/properties/${prop}`, { method: 'PUT', body: value }); // <= 32 KB JSON

export async function transitionTo(key: string, target: { name?: string; categoryKey?: 'new' | 'indeterminate' | 'done' }) {
  const { transitions } = await jira<{ transitions: { id: string; name: string; to: { name: string; statusCategory: { key: string } } }[] }>(
    `/rest/api/3/issue/${key}/transitions`);
  const t = transitions.find((x) =>
    (target.name && (x.to.name === target.name || x.name === target.name)) ||
    (target.categoryKey && x.to.statusCategory.key === target.categoryKey));
  if (!t) throw new Error(`${key}: no transition to ${JSON.stringify(target)}; available: ${transitions.map((x) => x.name).join(', ')}`);
  await jira(`/rest/api/3/issue/${key}/transitions`, { method: 'POST', body: { transition: { id: t.id } } }); // 204
}

// ---------- poll once ----------
declare const db: {
  getCursor(source: string): Promise<string | undefined>;
  setCursor(source: string, v: string): Promise<void>;
  markSeen(source: string, id: string, version: string): Promise<boolean>; // true if newly inserted
};
declare function enqueueWorkRequest(req: { source: 'jira'; externalId: string; title: string; text: string; requestedBy?: string }): Promise<void>;

export async function pollJiraOnce(project: string, timeZone: string) {
  const OVERLAP_MS = 5 * 60_000;
  const cursor = new Date((await db.getCursor('jira')) ?? Date.now() - 24 * 3600_000);
  const since = jqlDate(new Date(cursor.getTime() - OVERLAP_MS), timeZone);
  const jql = `project = ${project} AND labels = "factory" AND (labels not in ("factory-picked")) ` +
    `AND statusCategory = "To Do" AND updated >= "${since}" ORDER BY updated ASC`;
  let maxUpdated = cursor.getTime();
  for await (const issue of searchJql(jql, ['summary', 'description', 'labels', 'status', 'updated', 'reporter'])) {
    if (await db.markSeen('jira', issue.id, issue.fields.updated)) {
      await enqueueWorkRequest({ source: 'jira', externalId: issue.key, title: issue.fields.summary,
        text: adfToText(issue.fields.description), requestedBy: issue.fields.reporter?.accountId });
      await addLabel(issue.key, 'factory-picked');
      await setProperty(issue.key, 'software-factory', { state: 'picked', at: new Date().toISOString() });
    }
    maxUpdated = Math.max(maxUpdated, Date.parse(issue.fields.updated));
  }
  await db.setCursor('jira', new Date(maxUpdated).toISOString());
}
```

### 2.10 Jira Data Center differences (brief)

- **Auth:** personal access tokens (`Authorization: Bearer <PAT>`, available since Jira 8.14 [U]) or basic auth with a password. There are no Atlassian API tokens and no scoped tokens. The base URL is your own host plus context path.
- **API:** REST **v2** (`/rest/api/2/…`). Rich text is **wiki-markup strings, not ADF**. Search is the classic `GET|POST /rest/api/2/search` with `startAt`/`maxResults`/`total`. Cloud's `search/jql` and `nextPageToken` don't exist on DC [U for the newest DC releases].
- **Webhooks:** `/rest/webhooks/1.0/webhook`. Secret and HMAC support depends on version [U]. Rate limiting is admin-configured, if enabled at all.
- **Lifecycle** [U, from third-party summaries of Atlassian's announcement]: Data Center new sales ended 2026-03-30. Existing customers can expand until 2028-03-30, and Data Center reaches end of life on 2029-03-28.
- Abstract it as a `JiraClient` with `search(jql)` and `richText(adf | wiki)` adapters if you must support both.

---

## 3. GitHub

### 3.1 Auth

| Option | Use when | Key facts |
|---|---|---|
| **Fine-grained PAT** | Start here: one owner, a few repos | Repository-scoped. Actions appear as you, so consider a machine user. Permissions needed (repository) [V, per the fine-grained permission tables]: **Issues** R/W (list issues, comments, labels, reactions), **Pull requests** R/W (reviews, review comments, create PR), **Contents** R/W (push branches), **Commit statuses** R/W, **Metadata** R (always). **There is no "Checks" permission for fine-grained PATs** [V, the docs have no such section, and a community thread confirms]. Whether a fine-grained PAT can *read* `GET …/check-runs` is [U]: docs and community reports conflict, so test it. Read CI via GraphQL `statusCheckRollup`, `gh pr checks`, or use an App. |
| **GitHub App** | Long-term: bot identity `yourapp[bot]`, higher limits, webhooks configured once | Sign a JWT (RS256, `iss` = App/Client ID, `exp` ≤10 min), then `POST /app/installations/{installation_id}/access_tokens`, which returns a token valid for 1 hour. Permissions: Issues, Pull requests, Contents, Commit statuses, **Checks R/W** (only Apps can **create** check runs [V]). Rate limit: 5,000/h, plus 50/h per repo and per org user beyond 20, capped at 12,500/h (15,000 on Enterprise Cloud) [V]. |
| **`gh` CLI** | Shelling out from agents | Uses `GH_TOKEN` (or `GITHUB_TOKEN`) from env, either token type. Good for `gh pr create/checks/view`. |
| Classic PAT | Avoid | Broad `repo` scope. Needed only for the few APIs fine-grained tokens lack. |

### 3.2 API version header

Send `X-GitHub-Api-Version: 2026-03-10` (newest) or `2022-11-28`. If you omit the header you get 2022-11-28, which is supported until 2028-03-10 [V]. Breaking changes in 2026-03-10 that touch this design [V]: the singular `assignee` field and parameter are removed (use `assignees`); `merge_commit_sha` is removed from pull request payloads; `rate` is removed from `GET /rate_limit` (use `resources.core`). Labels, reviews and pagination are unchanged.

### 3.3 Polling issues and PRs by label

```http
GET /repos/{owner}/{repo}/issues?labels=factory&state=open&sort=updated&direction=asc&since=2026-10-30T13:00:00Z&per_page=100
If-None-Match: "<etag from last response>"
```
- [V] Parameters: `labels` (comma-separated, AND semantics), `state` (`open|closed|all`), `sort` (`created|updated|comments`), `direction`, `since` (ISO 8601; matches items **updated** after it), `per_page` ≤100, `page`, plus `assignee`, `creator`, `mentioned`, `milestone`, `type`.
- **PRs are included.** Every PR is an issue, and PRs carry a `pull_request` key, so filter on it [V]. For PR-specific fields use `GET /repos/{o}/{r}/pulls?state=open&sort=updated&direction=desc`, which has no label filter.
- Paginate with the `Link: <…>; rel="next"` header.
- **Conditional requests:** store the `etag` and send `If-None-Match`. A `304` **doesn't count against the primary rate limit** when the request is authorized [V]. If `X-Poll-Interval` is present, wait at least that long [V]. GitHub's guidance prefers webhooks over polling [V], but a 60 s ETag poll per repo is cheap.
- Any new comment or label bumps `updated_at`, so the same query also surfaces follow-up comments on tracked issues.
- **Authorize the trigger.** `GET /repos/{o}/{r}/issues/{n}/events` and find the last `labeled` event for your label. Its `actor.login` is who applied it. Then call `GET /repos/{o}/{r}/collaborators/{login}/permission` and require `write`, `maintain` or `admin`. These are standard endpoints; I didn't re-fetch them today.
- Mark pickup by adding the label `factory-picked` (`POST /repos/{o}/{r}/issues/{n}/labels {"labels": [...]}`), an `eyes` reaction, and a status comment.
- Avoid `GET /search/issues` for polling. It has a separate, much lower rate limit (30/min authenticated [U]) and is eventually consistent.

### 3.4 Webhooks (optional, via the tunnel)

- Events to subscribe: `issues` (`opened`, `labeled`, `edited`), `issue_comment` (`created`), `pull_request` (`opened`, `synchronize`, `closed`), `pull_request_review` (`submitted`, `dismissed`), `pull_request_review_comment`, `pull_request_review_thread` (`resolved`), `check_suite` / `check_run` (`completed`), `status`. In webhook payloads `review.state` is lowercase (`changes_requested`, `approved`, `commented`), while REST returns uppercase [U].
- **Signature** [V]: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`, compared in constant time. Test vector: secret `It's a Secret to Everybody` with payload `Hello, World!` gives `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`. I reproduced this vector with `verify.github()` in §9.1. `X-Hub-Signature` (SHA-1) is legacy.
- Respond 2xx **within 10 s** and queue the work [V]. `X-GitHub-Delivery` is a unique delivery id; redeliveries reuse it, so dedupe on it [V]. GitHub doesn't document automatic redelivery: redeliver failed deliveries yourself via the hook deliveries API [U], or let the poller catch up.

### 3.5 Creating the PR: `gh` vs REST

| | `gh pr create` | `POST /repos/{o}/{r}/pulls` |
|---|---|---|
| Call | `git push -u origin factory/ENG-42 && gh pr create --base main --head factory/ENG-42 --title "ENG-42: …" --body-file pr.md --draft --label factory --reviewer alice` | `{"title", "head": "factory/ENG-42", "base": "main", "body", "draft": true}` returns `{number, html_url, …}` (Pull requests: write) [V] |
| Pros | Fewer lines. Reuses `gh` auth. Templates (`--template`), `--fill` from commits, project and milestone flags [V, gh 2.87.3] | Structured result, no subprocess, easy retries and idempotency checks (`GET /pulls?head=owner:branch&state=open` first) |
| Cons | Parse the URL from stdout. Interactive prompts unless every field is given. "May still push git changes" even with `--dry-run` [V]. | Labels and reviewers need extra calls (`POST /issues/{n}/labels`, `POST /pulls/{n}/requested_reviewers`) |

Recommendation: use REST (or `gh api`) inside the service, and `gh` inside agent sandboxes where a human-like CLI is natural. Either way, push the branch first.

### 3.6 Feedback loop: reviews, comments, CI

| Need | Endpoint | Notes |
|---|---|---|
| Reviews | `GET /repos/{o}/{r}/pulls/{n}/reviews` | `state`: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. Chronological. Pull requests: read [V perm] |
| Inline review comments | `GET /repos/{o}/{r}/pulls/{n}/comments?sort=updated&direction=asc&since=…`, or repo-wide `GET /repos/{o}/{r}/pulls/comments?since=…` [V] | Fields `id, pull_request_review_id, in_reply_to_id, path, line, side, diff_hunk, body, user, created_at, updated_at, commit_id` [V] |
| Reply to an inline comment | `POST /repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies {"body"}` | Only to top-level review comments [V] |
| PR conversation comments | `GET /repos/{o}/{r}/issues/{n}/comments?since=…`, or repo-wide `GET /repos/{o}/{r}/issues/comments?since=…&sort=updated` | The same endpoints as for issues |
| Check runs | `GET /repos/{o}/{r}/commits/{sha}/check-runs?filter=latest&per_page=100` [V] | `status` ∈ queued, in_progress, completed, waiting, requested, pending. `conclusion` ∈ success, failure, neutral, cancelled, skipped, timed_out, action_required, null. `output.{title, summary, text, annotations_count}`. Annotations at `GET /repos/{o}/{r}/check-runs/{id}/annotations`. Returns at most the 1,000 most recent check suites per ref [V]. |
| Combined commit status | `GET /repos/{o}/{r}/commits/{sha}/status` | Legacy statuses only (not check runs). Commit statuses: read [V] |
| Everything at once | GraphQL `pullRequest { reviewDecision reviews reviewThreads{isResolved} commits(last:1){commit{statusCheckRollup}} }` | Thread **resolution** (`isResolved`, `isOutdated`) exists only in GraphQL. See the code below. |
| CLI | `gh pr checks 128 --json name,state,bucket,link,workflow [--required] [--watch --fail-fast]` | `bucket` ∈ `pass`, `fail`, `pending`, `skipping`, `cancel`. **Exit code 8 = checks pending** [V, gh 2.87.3]. `gh pr view 128 --json reviewDecision,latestReviews,reviews,comments,statusCheckRollup,headRefOid,mergeStateStatus` [V] |

**Detecting "changes requested".** Take each human reviewer's **latest** non-`COMMENTED` review; changes are requested if any of them is `CHANGES_REQUESTED`. GraphQL `reviewDecision` (`APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED`) computes this for you, but it may be `null` when no review rule applies to the base branch [U]. In that case fall back to the per-reviewer computation.

**"New since last seen".** Persist `{lastReviewId, lastCommentId, headSha}` per PR. Review and comment ids increase over time, so `id > last` finds new ones. Also compare `updated_at` to catch edits. Ignore your own login and `*[bot]` authors. When `headRefOid` changes (you pushed), reset the CI state and wait for checks on the new SHA. Only re-engage the agent when there are new human comments, a new `CHANGES_REQUESTED`, or the CI rollup goes `FAILURE`/`ERROR`, and debounce for about 2 min so a reviewer can finish a batch.

### 3.7 Posting status back to GitHub

- Comment: `POST /repos/{o}/{r}/issues/{n}/comments {"body"}`. Edit it in place with `PATCH /repos/{o}/{r}/issues/comments/{comment_id}`. Embed a hidden marker such as `<!-- software-factory:run=wi_123 -->` so you can find your own comment after a crash.
- Reactions: `POST /repos/{o}/{r}/issues/{n}/reactions {"content": "eyes"}`. The allowed values are `+1, -1, laugh, confused, heart, hooray, rocket, eyes` (Issues: write [V perm]).
- Commit status on the PR head: `POST /repos/{o}/{r}/statuses/{sha} {"state": "pending|success|failure|error", "context": "software-factory", "description", "target_url"}` (Commit statuses: write [V]).
- Check runs with rich output (`POST /repos/{o}/{r}/check-runs`) are **GitHub App only** [V].
- Write politely: make mutating requests serially, at least 1 s apart [V]. The secondary limit is about 80 content-creating requests/min and 500/h [V].

### 3.8 Rate limits [V]

- Primary: PAT 5,000/h (15,000 for apps owned by an Enterprise Cloud org). App installations: see 3.1. `GITHUB_TOKEN` 1,000/h per repo. Unauthenticated 60/h.
- Secondary: ≤100 concurrent requests. 900 points/min for REST (GET = 1 point, mutation = 5) and 2,000 for GraphQL. 90 s of CPU per 60 s. About 80 content-creating requests/min and 500/h.
- Headers: `x-ratelimit-limit`, `-remaining`, `-used`, `-reset` (epoch seconds), `-resource`.
- On 403 or 429: if `retry-after` is present, wait that long. Else if `x-ratelimit-remaining` is 0, wait until `x-ratelimit-reset`. Else wait at least 60 s, then back off exponentially. Hammering while limited can get the integration banned.

### 3.9 Minimal TypeScript: ETag polling, trigger authorization, PR feedback, write-back

```ts
// github.ts: label polling with ETags + PR feedback loop via one GraphQL query (no SDK).
const GH_TOKEN = process.env.GH_TOKEN ?? ''; // fine-grained PAT or GitHub App installation token
const headers = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10', // or '2022-11-28' (default; supported until 2028-03-10)
  'User-Agent': 'software-factory',
};
const etags = new Map<string, { etag: string; body: unknown }>(); // persist in DB to survive restarts

export class RateLimited extends Error {
  retryAfterMs: number;
  constructor(ms: number) { super(`rate limited for ${ms} ms`); this.retryAfterMs = ms; }
}

export async function gh<T = any>(url: string, init: { method?: string; body?: unknown } = {}): Promise<{ data: T; next?: string; pollInterval?: number }> {
  const full = url.startsWith('http') ? url : `https://api.github.com${url}`;
  const cached = !init.method || init.method === 'GET' ? etags.get(full) : undefined;
  const res = await fetch(full, {
    method: init.method ?? 'GET',
    headers: { ...headers, ...(cached ? { 'If-None-Match': cached.etag } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    const reset = res.headers.get('x-ratelimit-reset');
    if (retryAfter) throw new RateLimited(Number(retryAfter) * 1000);
    if (res.headers.get('x-ratelimit-remaining') === '0' && reset) throw new RateLimited(Number(reset) * 1000 - Date.now());
    if (res.status === 429) throw new RateLimited(60_000); // secondary limit without headers: wait >= 1 min
  }
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
  const pollInterval = Number(res.headers.get('x-poll-interval') ?? 0) || undefined;
  if (res.status === 304 && cached) return { data: cached.body as T, next, pollInterval }; // free: not counted
  if (!res.ok) throw new Error(`github ${init.method ?? 'GET'} ${full} -> ${res.status} ${await res.text()}`);
  const data = (res.status === 204 ? undefined : await res.json()) as T;
  const etag = res.headers.get('etag');
  if (etag && (!init.method || init.method === 'GET')) etags.set(full, { etag, body: data });
  return { data, next, pollInterval };
}

type Issue = { id: number; number: number; title: string; body: string | null; updated_at: string;
  html_url: string; user: { login: string }; labels: { name: string }[]; pull_request?: unknown };

/** All open issues (not PRs) with `label`, updated since `since`, oldest-first. */
export async function listLabeledIssues(owner: string, repo: string, label: string, since: string): Promise<Issue[]> {
  const out: Issue[] = [];
  let url: string | undefined = `/repos/${owner}/${repo}/issues?` + new URLSearchParams({
    labels: label, state: 'open', sort: 'updated', direction: 'asc', since, per_page: '100' });
  while (url) {
    const page: { data: Issue[]; next?: string } = await gh<Issue[]>(url);
    out.push(...page.data.filter((i) => !i.pull_request)); // the issues endpoint also returns PRs
    url = page.next;
  }
  return out;
}

/** Who applied the trigger label? Only act if they have write/maintain/admin. */
export async function labelAppliedBy(owner: string, repo: string, issue: number, label: string): Promise<string | undefined> {
  const { data } = await gh<{ event: string; actor: { login: string }; label?: { name: string } }[]>(
    `/repos/${owner}/${repo}/issues/${issue}/events?per_page=100`); // paginate for long histories
  return data.filter((e) => e.event === 'labeled' && e.label?.name === label).at(-1)?.actor.login;
}
export async function repoPermission(owner: string, repo: string, login: string) {
  const { data } = await gh<{ permission: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' }>(
    `/repos/${owner}/${repo}/collaborators/${login}/permission`);
  return data.permission;
}

// ---------- PR feedback in one GraphQL call ----------
const PR_STATE = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft headRefOid reviewDecision mergeStateStatus
      reviews(last: 50) { nodes { databaseId state submittedAt author { login } body } }
      reviewThreads(last: 100) { nodes { isResolved isOutdated path line
        comments(last: 20) { nodes { databaseId createdAt author { login } body } } } }
      comments(last: 50) { nodes { databaseId createdAt author { login } body } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state
        contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state targetUrl description } } } } } } }
    }
  }
}`;

export type Seen = { reviewId: number; commentId: number; headSha?: string };

export async function prFeedback(owner: string, name: string, number: number, seen: Seen, botLogin: string) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: PR_STATE, variables: { owner, name, number } }),
  });
  const json = (await res.json()) as { data?: any; errors?: unknown[] };
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  const pr = json.data.repository.pullRequest;
  const human = (login?: string) => login && login !== botLogin && !login.endsWith('[bot]');

  const newReviews = pr.reviews.nodes.filter((r: any) => r.databaseId > seen.reviewId && human(r.author?.login));
  const changesRequested = pr.reviewDecision === 'CHANGES_REQUESTED' ||
    newReviews.some((r: any) => r.state === 'CHANGES_REQUESTED');
  const newComments = [
    ...pr.reviewThreads.nodes.filter((t: any) => !t.isResolved)
      .flatMap((t: any) => t.comments.nodes.map((c: any) => ({ ...c, path: t.path, line: t.line, kind: 'review' }))),
    ...pr.comments.nodes.map((c: any) => ({ ...c, kind: 'conversation' })),
  ].filter((c) => c.databaseId > seen.commentId && human(c.author?.login));

  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup; // null if no checks
  const failing = (rollup?.contexts.nodes ?? []).filter((c: any) =>
    (c.__typename === 'CheckRun' && ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c.conclusion)) ||
    (c.__typename === 'StatusContext' && ['FAILURE', 'ERROR'].includes(c.state)));

  return {
    headSha: pr.headRefOid as string,
    ciState: (rollup?.state ?? 'NONE') as 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | 'NONE',
    failing, changesRequested, newReviews, newComments,
    nextSeen: {
      reviewId: Math.max(seen.reviewId, ...pr.reviews.nodes.map((r: any) => r.databaseId ?? 0)),
      commentId: Math.max(seen.commentId, ...newComments.map((c: any) => c.databaseId), 0),
      headSha: pr.headRefOid,
    } satisfies Seen,
  };
}

// ---------- write-back ----------
export const comment = (owner: string, repo: string, n: number, body: string) =>
  gh<{ id: number }>(`/repos/${owner}/${repo}/issues/${n}/comments`, { method: 'POST', body: { body } });
export const editComment = (owner: string, repo: string, commentId: number, body: string) =>
  gh(`/repos/${owner}/${repo}/issues/comments/${commentId}`, { method: 'PATCH', body: { body } });
export const react = (owner: string, repo: string, n: number, content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes') =>
  gh(`/repos/${owner}/${repo}/issues/${n}/reactions`, { method: 'POST', body: { content } });
export const addLabels = (owner: string, repo: string, n: number, labels: string[]) =>
  gh(`/repos/${owner}/${repo}/issues/${n}/labels`, { method: 'POST', body: { labels } });
export const setStatus = (owner: string, repo: string, sha: string,
  state: 'error' | 'failure' | 'pending' | 'success', description: string, target_url?: string) =>
  gh(`/repos/${owner}/${repo}/statuses/${sha}`, { method: 'POST',
    body: { state, description, context: 'software-factory', target_url } });
export const createPr = (owner: string, repo: string, p: { title: string; head: string; base: string; body: string; draft?: boolean }) =>
  gh<{ number: number; html_url: string }>(`/repos/${owner}/${repo}/pulls`, { method: 'POST', body: p });
```

---

## 4. Linear

### 4.1 Auth

- Endpoint: `POST https://api.linear.app/graphql` [V].
- **Personal API key**: send `Authorization: <API_KEY>` with **no `Bearer`** prefix [V]. Create it as a dedicated bot member so comments show the bot's name. Linear may let you restrict a key's permissions or teams at creation [U]; check *Settings → Security & access*.
- **OAuth 2.0**: send `Authorization: Bearer <token>` [V]. The authorize URL `https://linear.app/oauth/authorize` and token URL `https://api.linear.app/oauth/token` are [U]. Scopes include `read`, `write`, `issues:create`, `comments:create` and `admin`, plus `app:assignable` and `app:mentionable` for agents [V for the last two]. Adding **`actor=app`** to the authorize URL installs the app as its own workspace user (not the installing human). Such apps **can't request `admin`**. Store the app user id from `viewer { id }` [V].
- Recommendation: use an API key for v1 polling. Switch to OAuth `actor=app` when you adopt the Agents API (4.5).

### 4.2 Polling issues by label and state [V, against the published SDK schema]

```graphql
query Poll($since: DateTimeOrDuration!, $after: String) {
  issues(first: 50, after: $after, orderBy: updatedAt, filter: {
    updatedAt: { gt: $since }
    labels: { some: { name: { eqIgnoreCase: "factory" } } }
    state: { type: { in: ["triage", "backlog", "unstarted"] } }
  }) {
    nodes { id identifier title description url updatedAt
            creator { id name } team { id key } state { id name type } labels { nodes { id name } } }
    pageInfo { hasNextPage endCursor }
  }
}
```
- `DateComparator.gt` accepts an ISO timestamp **or** an ISO 8601 duration (e.g. `"-PT10M"`), because the type is `DateTimeOrDuration`. Comparators are `eq, neq, in, nin, lt, lte, gt, gte`. Strings also take `eqIgnoreCase, contains, containsIgnoreCase, startsWith, …`. Collections take `some`, `every` and `length` [V]. Fields within a filter object are combined with AND; use `or: [...]` for OR [V].
- Workflow `state.type` values: `triage, backlog, unstarted, started, completed, canceled, duplicate` [V]. `orderBy` is `createdAt | updatedAt` [V]. Page size defaults to 50, so set `first` explicitly [V]. The sort direction isn't documented, so compute `max(updatedAt)` yourself.
- `description` is Markdown.
- Other useful filters [V]: `delegate` (issues delegated to an agent), `assignee`, `team: { key: { eq: "ENG" } }`, `hasActiveAgentSessions`.
- **Who added the label:** `issue(id) { history(first: 50) { nodes { actor { id } addedLabelIds createdAt } } }` (`IssueHistory` has `actor`, `addedLabelIds`, `removedLabelIds`, `fromStateId` and `toStateId` [V]).
- Linear "especially discourages" polling and recommends webhooks [V]. One poll per minute is still only 60 of 2,500 requests per hour.

### 4.3 Comments, labels, state, reactions [V schema]

- `commentCreate(input: { issueId, body, parentId?, id? })` returns `{ success, comment { id url } }`. `parentId` makes a **threaded reply**. `id` lets you **choose the UUID yourself**, which makes retries idempotent; the field exists, the duplicate-rejection behavior is [U]. The body is Markdown. `createAsUser` and `displayIconUrl` exist for OAuth `actor=app` apps.
- `commentUpdate(id, input: { body })` edits in place.
- `issueUpdate(id, input: { stateId, addedLabelIds, removedLabelIds, labelIds, assigneeId, delegateId })`. Also `issueAddLabel(id, labelId)`. Find state ids with `team(id) { states { nodes { id name type } } }`.
- `reactionCreate(input: { emoji, commentId | issueId })`. The emoji string format (shortcode `"eyes"` vs a unicode character) is [U].

### 4.4 Webhooks [V]

- Create them in *Settings → API → New webhook* (workspace admins or OAuth `admin` scope), or with `webhookCreate(input: { url, teamId | allPublicTeams: true, resourceTypes: ["Issue", "Comment", "IssueLabel"], secret?, label?, enabled })`.
- Resource types include Issue, Comment, IssueLabel, Reaction (comment reactions), Project, ProjectUpdate, Cycle, Document, Initiative, Customer, CustomerRequest, User, IssueSLA and OAuthApp revoked.
- Headers: `Linear-Delivery` (a UUID, so dedupe on it), `Linear-Event`, `Linear-Signature` (hex HMAC-SHA256 of the **raw** body with the webhook secret), and `Linear-Timestamp` (ms).
- Reject requests where `webhookTimestamp` is more than 60 s from your clock.
- Payload: `{ action: "create"|"update"|"remove", type: "Issue", actor, createdAt, data, url, updatedFrom, webhookTimestamp, webhookId, organizationId }`. `updatedFrom` holds the previous values of changed fields, which lets you detect "label just added" without re-fetching.
- Return 200 **within 5 s**. Failed deliveries are retried 3 times (after 1 min, 1 h and 6 h). A webhook that stays unresponsive may be disabled and must be re-enabled manually. Linear publishes its source IPs on its security page.

### 4.5 Linear Agents (AgentSession, delegate-to-agent). It exists, in **Developer Preview** [V]

- The docs say the "Linear for Agents" APIs are in **Developer Preview** and may change before GA [V, docs as of today].
- **Setup:** create an OAuth Application, enable webhooks with **"Agent session events"**, and install it with `actor=app` and the scopes `app:assignable` and/or `app:mentionable` [V]. Agents can't be project members or leads [V].
- **Delegation:** assigning an issue to the agent sets **`delegate`**, not `assignee`, so the human keeps ownership [V].
- **Lifecycle:** mentioning or delegating the agent creates an `AgentSession` automatically and sends an `AgentSessionEvent` webhook [V]:
  - `action: "created"`: build your prompt from `promptContext` (a formatted string with the issue, comments and guidance). Structured data is in `agentSession.issue`, `agentSession.comment`, `previousComments` and `guidance`.
  - `action: "prompted"`: the user replied in the session. The text is in `agentActivity.body`.
  - The payload type `AgentSessionEventWebhookPayload` has `{ action, agentSession, agentActivity?, promptContext?, previousComments?, guidance?, appUserId, oauthClientId, organizationId, webhookId, webhookTimestamp, createdAt, type }` [V schema].
- **Timing:** return the webhook **within 5 s**. Within **10 s** of `created`, emit an activity or set an external URL, or the session is marked unresponsive [V].
- **Activities:** `agentActivityCreate(input: { agentSessionId, content: JSONObject, ephemeral?, signal?, signalMetadata?, id? })` [V schema]. The content shape depends on `type` [V]:
  ```graphql
  mutation { agentActivityCreate(input: { agentSessionId: "…",
    content: { type: "thought", body: "Reading the issue and the repo…" } }) { success } }
  # { type: "action", action: "Running tests", parameter: "npm test" } then { type: "action", action: "Ran tests", parameter: "npm test", result: "41 passed" }
  # { type: "elicitation", body: "Approve this plan?" }   -> session becomes awaitingInput
  # { type: "response", body: "Opened PR octo/app#128" } -> complete
  # { type: "error", body: "CI failed: …" }
  ```
  `ephemeral` applies only to `thought` and `action` activities. Agents can't create `prompt` activities [V]. The signals enum is `auth | continue | select | stop` [V schema]; their semantics are documented on a separate page I didn't fetch [U].
- **Session status** (set by Linear from your last activity): `pending, active, awaitingInput, complete, error, stale`. The schema also has `stopping` [V].
- `agentSessionUpdate(id, input: { externalUrls | addedExternalUrls | removedExternalUrls, plan, summary })`. Setting `externalUrls` replaces the whole array. `plan` is a list of `{content, status: pending|inProgress|completed|canceled}` steps, and the Agent Plan API is in technology preview [V].
- **Proactive sessions:** `agentSessionCreateOnIssue(input: { issueId, externalUrls? })` and `agentSessionCreateOnComment(input: { commentId, … })` [V].
- **Polling?** The schema has `agentSessions(first, after, orderBy: updatedAt)` and `AgentSession.activities(...)` [V], so you *could* poll for sessions. But the 10 s acknowledgement rule makes polling impractical, which leaves it [U]. **Treat Agents as webhook-only** and route it through the Cloudflare tunnel. Keep plain label or assignee polling as the fallback intake.
- Mapping to the Conversation abstraction (§8): `post`/`reply` → a `response` or `thought` activity; `askApproval` → an `elicitation` (optionally with the `select` signal [U]); `setStatus` → `agentSessionUpdate.plan` or `summary`; links → `externalUrls`.

### 4.6 Rate limits [V]

| | Requests/h | Complexity points/h |
|---|---|---|
| API key (per user, shared across their keys) | 2,500 | 3,000,000 |
| OAuth app (per user / app user) | 5,000 | 2,000,000 |
| Unauthenticated (per IP) | 600 | 100,000 |

- The maximum is **10,000 points per query**. Each property costs 0.1, each object 1, and connections multiply by `first` (default 50).
- Response headers: `X-RateLimit-Requests-{Limit,Remaining,Reset}` (reset in epoch ms), `X-Complexity`, and `X-RateLimit-Complexity-{Limit,Remaining,Reset}`.
- Hitting a limit returns HTTP 429 with `errors[].extensions.code = "RATELIMITED"` and `Retry-After`.
- OAuth apps using actor authorization may get dynamic, higher limits.

### 4.7 Minimal TypeScript

```ts
// linear.ts: Linear GraphQL poller + write-back (no SDK).
const LINEAR_KEY = process.env.LINEAR_API_KEY ?? ''; // personal key: sent WITHOUT "Bearer"; OAuth token: "Bearer <t>"

export async function linear<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: LINEAR_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  if (res.status === 429 || json.errors?.some((e) => e.extensions?.code === 'RATELIMITED')) {
    throw Object.assign(new Error('linear rate limited'), { retryAfterMs: Number(res.headers.get('retry-after') ?? 60) * 1000 });
  }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data as T;
}

const POLL = `
query Poll($since: DateTimeOrDuration!, $after: String) {
  issues(first: 50, after: $after, orderBy: updatedAt, filter: {
    updatedAt: { gt: $since }
    labels: { some: { name: { eqIgnoreCase: "factory" } } }
    state: { type: { in: ["triage", "backlog", "unstarted"] } }
  }) {
    nodes { id identifier title description url updatedAt
      creator { id name } team { id key } state { id name type }
      labels { nodes { id name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export type LinearIssue = { id: string; identifier: string; title: string; description: string | null; url: string;
  updatedAt: string; creator: { id: string; name: string } | null; team: { id: string; key: string };
  state: { id: string; name: string; type: string }; labels: { nodes: { id: string; name: string }[] } };

export async function pollLinear(sinceIso: string): Promise<LinearIssue[]> {
  const out: LinearIssue[] = [];
  let after: string | undefined;
  do {
    const d = await linear<{ issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }>(
      POLL, { since: sinceIso, after });
    out.push(...d.issues.nodes);
    after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : undefined;
  } while (after);
  return out; // don't rely on sort direction: compute max(updatedAt) yourself
}

export const addComment = (issueId: string, body: string, opts: { id?: string; parentId?: string } = {}) =>
  linear<{ commentCreate: { success: boolean; comment: { id: string; url: string } } }>(`
    mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`,
    { input: { issueId, body, ...opts } }); // `id` = client-chosen UUID -> idempotent retries

export const updateComment = (id: string, body: string) =>
  linear(`mutation($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`,
    { id, input: { body } });

export const setState = (issueId: string, stateId: string, addedLabelIds: string[] = []) =>
  linear(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    { id: issueId, input: { stateId, addedLabelIds } });

export const reactToComment = (commentId: string, emoji: string) =>
  linear(`mutation($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }`,
    { input: { commentId, emoji } });

export const workflowStates = (teamId: string) =>
  linear<{ team: { states: { nodes: { id: string; name: string; type: string }[] } } }>(
    `query($id: String!) { team(id: $id) { states { nodes { id name type } } } }`, { id: teamId });
```

---

## 5. Scheduled and polling intake engine

### 5.1 `setInterval` vs a `setTimeout` chain vs `croner`

| | `setInterval` | Self-scheduling `setTimeout` loop | `croner` 11.0.0 |
|---|---|---|---|
| Overlap if a poll is slow | **Yes**, runs pile up | No: the next run is scheduled after the previous finishes | `protect: true` blocks new triggers while one is running [V] |
| Dynamic delay (Retry-After, X-Poll-Interval, backoff) | Awkward | Natural | Not its job |
| Wall-clock schedules ("weekdays 09:07 in a given time zone") | No | No | Yes: cron syntax with optional seconds and year, IANA `timezone`, DST-aware (v11 aligns with Vixie cron) [V] |
| Deps | none | none | zero dependencies, TS typings included [V] |

**Recommendation.** Use **both** primitives:
- **Source pollers** (Jira, GitHub, Linear, Gmail, Slack backfill) use the `setTimeout` loop in `pollLoop()` below. It never overlaps, adds jitter, backs off exponentially, and never retries before `Retry-After`.
- **Calendar jobs** (daily metric reviews, weekly dependency sweeps, re-calling `gmail.users.watch`) use **croner**: `new Cron(pattern, { name, timezone, protect: true, catch, maxRuns, startAt, stopAt, interval, paused, unref }, fn)`. Methods include `nextRun(from?)`, `nextRuns(n)`, `previousRun()`, `trigger()`, `pause()`, `resume()`, `stop()`, `isBusy()` and `enumerate()` [V].
- I'd pick croner over `node-cron` or `cron` for its overrun protection, time-zone and DST correctness, zero dependencies and active maintenance (v11.0.0 shipped 2026-10-25).
- croner v11 breaking changes [V]: DST gap and overlap handling changed, `startAt` is now inclusive, and `previousRun()` returns the previous run's start time.
- BullMQ, Agenda and Bree add Redis or Mongo or worker threads you don't need on a single Mac.
- Neither primitive catches up runs missed while the process was down or the Mac was asleep. Timers just fire late after wake. Persist `last_run_at` and catch up explicitly, as `cronJob()` does.

### 5.2 Idempotency, cursors, catch-up

**Dedupe key.** Use `(source, external_id, version)` in a `seen` table, inserted with `INSERT OR IGNORE`; `changes === 1` means new. `version` is the source's own change marker:

| Source | external_id | version | cursor (stored) | overlap |
|---|---|---|---|---|
| Jira | `issue.id` (stable; keys change on project moves) | `fields.updated` | max `fields.updated` seen | 5 min (minute-precision JQL and eventual consistency) |
| GitHub | `issue.node_id` or `owner/repo#number` | `updated_at` | max `updated_at`, plus the ETag per URL | 2 min |
| Linear | `issue.id` (UUID) | `updatedAt` | max `updatedAt` | 2 min |
| Slack (backfill) | `channel:ts` | `ts` (or `edited.ts`) | max `ts` per channel | none (`ts` is exact) |
| Slack (socket) | `event_id` | n/a | n/a | n/a |
| Gmail | `message.id` | n/a | `historyId` | none |

**Work-item identity** is separate from event dedupe. `work_items` is UNIQUE on `(source, external_id)`, so a ticket edited five times is still **one** work item; later versions become `followup` events, or are ignored.

**Cursor protocol (at-least-once):**
1. Query `updated >= cursor - overlap`, ordered ascending.
2. For each item: `markSeen`. If new, normalize, upsert the work item, and enqueue, in one SQLite transaction.
3. Advance the cursor to `max(version)` **only after** the whole page commits. Never set it to "now", because of clock skew and eventual consistency.
4. Re-read **current** state before acting (does the label still exist, is the status still To Do, is the trigger still authorized?). Polling sees snapshots, and the trigger may already have been revoked.

**Backoff.** Use exponential backoff `everyMs × 2^failures` with ±20% jitter, capped at 15 min. Take the max with `Retry-After`. Reset after a success. Count failures per source, so one broken integration doesn't stall the others. Open a circuit, and post an alert to yourself, after about 10 consecutive failures.

**Catch-up after downtime:**
- The cursor approach catches up automatically. Bound the look-back (e.g. 7 days) and **paginate fully** before enqueueing, so a long outage doesn't turn into a burst of agent runs. Cap concurrency, process oldest-first, and require the trigger condition to still hold *now*.
- Slack Socket Mode loses events once Slack's retries are exhausted. On startup, backfill each watched channel and every active thread from the stored max `ts`.
- Webhooks you missed while down: Jira retries for up to about 75 min, GitHub doesn't redeliver automatically, Linear retries at 1 min, 1 h and 6 h. **Pollers cover all of these.**
- Calendar jobs: compare `nextRun(last_run_at)` with now, and run **once** to coalesce all missed occurrences.
- On a Mac, run under `launchd` with `KeepAlive` and prevent system sleep (`caffeinate -s`, or Energy settings) if you need continuous intake [U, OS-specific].

**Write-back outbox.** Write status updates to an `outbox` table first, then let a worker deliver them with retries, recording the returned message ids (Slack `ts`, comment ids). Sources without idempotency keys need care:
- **Linear**: pass a client-generated comment `id`.
- **Slack**: put `metadata.event_payload.run_id` on the message.
- **GitHub**: embed a hidden HTML marker in the comment body.
- **Jira**: set a comment property.

After a crash, look for an existing message carrying your marker **before** re-posting.

### 5.3 TypeScript: store, poll loop, cron with catch-up

```ts
// poller.ts: self-scheduling poll loops (no overlap, jitter, backoff, Retry-After) + croner for wall-clock jobs.
import { Cron } from 'croner';
import { DatabaseSync } from 'node:sqlite'; // built in; still prints an ExperimentalWarning on Node 25

export const db = new DatabaseSync(process.env.FACTORY_DB ?? 'factory.db');
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS seen (
    source TEXT NOT NULL, external_id TEXT NOT NULL, version TEXT NOT NULL, seen_at TEXT NOT NULL,
    PRIMARY KEY (source, external_id, version));
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, state TEXT NOT NULL,
    conversation TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (source, external_id));
  CREATE TABLE IF NOT EXISTS job_runs (job TEXT PRIMARY KEY, last_run_at TEXT NOT NULL);
`);

export const store = {
  getCursor: (source: string) =>
    (db.prepare('SELECT value FROM cursors WHERE source = ?').get(source) as { value: string } | undefined)?.value,
  setCursor: (source: string, value: string) =>
    db.prepare(`INSERT INTO cursors (source, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (source) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(source, value, new Date().toISOString()),
  /** Idempotency gate: true exactly once per (source, external id, version). */
  markSeen: (source: string, externalId: string, version: string) =>
    db.prepare('INSERT OR IGNORE INTO seen (source, external_id, version, seen_at) VALUES (?, ?, ?, ?)')
      .run(source, externalId, version, new Date().toISOString()).changes === 1,
};

export type PollFn = (signal: AbortSignal) => Promise<{ minDelayMs?: number } | void>;

export function pollLoop(name: string, fn: PollFn, o: { everyMs: number; maxBackoffMs?: number; jitter?: number }) {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const schedule = (ms: number) => {
    const j = o.jitter ?? 0.2;
    if (!ac.signal.aborted) timer = setTimeout(tick, ms * (1 - j + Math.random() * 2 * j));
  };
  const tick = async () => {
    let delay = o.everyMs;
    try {
      const r = await fn(ac.signal);
      failures = 0;
      delay = Math.max(delay, r?.minDelayMs ?? 0);         // e.g. GitHub X-Poll-Interval
    } catch (err: any) {
      failures++;
      const backoff = Math.min(o.maxBackoffMs ?? 15 * 60_000, o.everyMs * 2 ** failures);
      delay = Math.max(backoff, Number(err?.retryAfterMs ?? 0)); // never retry before Retry-After
      console.error(`[poll:${name}] failure #${failures}, next in ${Math.round(delay / 1000)}s`, err?.message ?? err);
    }
    schedule(delay);
  };
  schedule(Math.random() * Math.min(5_000, o.everyMs)); // stagger startup
  return { stop: () => { ac.abort(); clearTimeout(timer); } };
}

/** Wall-clock job with catch-up: if a run was missed while the Mac slept / service was down, run once now. */
export function cronJob(name: string, pattern: string, timezone: string, run: () => Promise<void>) {
  const record = () => db.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES (?, ?)
    ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at`).run(name, new Date().toISOString());
  const job = new Cron(pattern, { name, timezone, protect: true, catch: (e) => console.error(`[cron:${name}]`, e) },
    async () => { await run(); record(); });
  const last = db.prepare('SELECT last_run_at FROM job_runs WHERE job = ?').get(name) as { last_run_at: string } | undefined;
  if (last) {
    const due = new Cron(pattern, { timezone }).nextRun(new Date(last.last_run_at));
    if (due && due.getTime() < Date.now()) void job.trigger(); // coalesce all missed runs into one
  }
  return job;
}

// Usage
// pollLoop('jira', () => pollJiraOnce('ENG', 'Asia/Kolkata'), { everyMs: 60_000 });
// pollLoop('github', async () => { /* ... */ return { minDelayMs: 60_000 }; }, { everyMs: 60_000 });
// cronJob('weekday-error-review', '7 9 * * 1-5', 'America/Los_Angeles', reviewErrorBudget);
```

### 5.4 Manual form intake

- Serve a small form on `127.0.0.1` (for example `node:http` with `POST /requests`). If you need it remotely, publish it through the tunnel **behind Cloudflare Access**, and verify the `Cf-Access-Jwt-Assertion` header [U for header details].
- Normalize each submission to the same `InboundEvent` (`source: 'form'`, `externalId` = a server-generated UUID, `requestedBy` = the Access identity). Add a CSRF token and a per-user rate limit.
- Write-back target: a status page with server-sent events, **or** let the submitter pick a destination (Slack DM, email), so the `ConversationRef` points at a real channel.

---

## 6. Stats and alerts as triggers (short)

- **Health or metrics endpoints.** Poll `GET /healthz` (with `AbortSignal.timeout(5000)`) or a Prometheus query (`GET /api/v1/query?query=…`). Alert on **N consecutive** bad samples, not on one.
- **Error trackers.** Use either the vendor's webhooks (Sentry: resources `issue`, `error`, `event_alert`, `metric_alert`; the `Sentry-Hook-Signature` header is a hex HMAC-SHA256 of the raw body with the client secret; **respond within 1 s** [V]) or poll its issues API for unresolved issues first seen in the last interval. The exact Sentry query endpoint and params are [U].
- **Log files.** Tail from a persisted byte offset. Detect rotation when the inode changes or the file shrinks. Normalize lines into a **fingerprint** (strip numbers, UUIDs, hex and timestamps, then hash). Count per window.
- **Detection.** Start with static thresholds plus hysteresis: open at >X for N intervals, resolve at <Y for M intervals. Optionally add an EWMA or rolling-median baseline. Keep a per-fingerprint cooldown.
- **Anomaly to ticket.** Use a dedupe key `monitor:<fingerprint>`. **Open one ticket** (Jira, Linear or GitHub) with the evidence: a sample, counts, first and last seen, links. While it stays active, **comment on or update the same ticket** instead of opening new ones. Cap tickets per day. The ticket then enters the normal pipeline through its label. Have production-affecting automatic fixes go through `askApproval`.

---

## 7. Email intake (optional): Gmail API

- **Auth.** Use OAuth for an installed or desktop app with a loopback redirect, and store the refresh token. Scopes: `gmail.readonly`, or `gmail.modify` (needed to relabel or mark read), plus `gmail.send` for replies.
- **Refresh-token expiry.** A consent screen left in **"Testing"** with the external user type issues refresh tokens that expire after **7 days** [U, long-standing Google OAuth policy]. Publish the app to production (an unverified app for personal use is fine), or use a Workspace internal app.
- **Label as the queue.** Have a Gmail filter apply a label such as `factory` (find its id with `GET …/users/me/labels`).
- **Full sync.** `GET https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=<id>&q=is:unread&maxResults=100` returns `{messages: [{id, threadId}], nextPageToken}`. Then fetch each with `GET …/messages/{id}?format=full`, and store the latest `historyId` [V, from the sync guide].
- **Partial sync (poll).** `GET https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=<id>&labelId=<id>&historyTypes=messageAdded&historyTypes=labelAdded&maxResults=500` returns `{history: [{messagesAdded, labelsAdded, …}], nextPageToken, historyId}` [V]. An **HTTP 404** means the start id is too old, so run a full sync. History is "typically available for at least one week", but sometimes for much less [V].
- **Mark done.** `POST …/messages/{id}/modify {"addLabelIds": ["<done>"], "removeLabelIds": ["<factory>", "UNREAD"]}`.
- **Reply in thread.** `POST …/messages/send {"raw": base64url(RFC 2822 with In-Reply-To/References and Subject "Re: …"), "threadId": "…"}`.
- **Push without an inbound URL.** Call `users.watch {topicName: "projects/<p>/topics/<t>", labelIds: [...], labelFilterBehavior: "INCLUDE"}`. Grant `gmail-api-push@system.gserviceaccount.com` publish rights on the topic and consume with a Pub/Sub **pull** subscription. `message.data` decodes (base64url) to `{"emailAddress", "historyId"}`; then run `history.list`. **Re-call `watch` at least every 7 days**; Google recommends daily [V].
- **Security.** Email is the easiest channel to spoof and inject. Allowlist senders, and check the `Authentication-Results` (DKIM/SPF) header [U for parsing details]. Never act on attachments without approval.

---

## 8. Posting status back: the Conversation abstraction

Each work item stores a `ConversationRef` at intake. Write-back always goes through `Conversation`, so the orchestrator never knows which source it is talking to. Approval *decisions* come back through intake as `InboundEvent`s, not as callbacks.

```ts
// conversation.ts: normalized write-back surface implemented once per source.
export type SourceKind = 'slack' | 'jira' | 'github' | 'linear' | 'gmail' | 'form' | 'monitor';

/** Persisted with the work item; enough to rebuild a Conversation after a restart. */
export interface ConversationRef {
  source: SourceKind;
  key: string; // stable, e.g. "slack:T0123:C0456:1730000000.000100", "jira:ENG-123", "github:octo/app#42", "linear:ENG-7"
  data: Record<string, string>; // e.g. { channel, threadTs, statusTs } | { issueKey, statusCommentId } | { owner, repo, number }
}

export interface MessageRef { conversation: ConversationRef; id: string } // Slack ts | Jira/GitHub/Linear comment id

export type Phase = 'received' | 'planning' | 'awaiting_approval' | 'working' | 'pr_open' | 'blocked' | 'done' | 'failed' | 'cancelled';
export type CanonicalReaction = 'seen' | 'working' | 'success' | 'failure';

export interface StatusUpdate {
  phase: Phase;
  title: string;                // one line, plain text
  detail?: string;              // markdown-ish; each adapter renders (mrkdwn / ADF / GFM / Linear MD)
  links?: { label: string; url: string }[];
}

export interface ApprovalRequest {
  approvalId: string;           // one-time id stored in DB; buttons/commands reference it
  question: string;
  approvers: string[];          // source-native user ids allowed to decide
  expiresAt: Date;
}

export interface ApprovalDecision { approvalId: string; decision: 'approve' | 'reject'; by: string; at: Date; note?: string }

export interface Capabilities { edit: boolean; threads: boolean; reactions: boolean; buttons: boolean; phaseField: boolean }

export interface Conversation {
  readonly ref: ConversationRef;
  readonly caps: Capabilities;
  /** New top-level message/comment. */
  post(text: string): Promise<MessageRef>;
  /** Reply in the request's thread (Slack thread_ts, Linear parentId; flat comment elsewhere). */
  reply(text: string, opts?: { notify?: boolean }): Promise<MessageRef>;
  /** Edit a message we posted earlier (single "living status" message). */
  update(msg: MessageRef, text: string): Promise<void>;
  /** Upsert the living status message: update if it exists, else post and remember its id. */
  setStatus(status: StatusUpdate): Promise<MessageRef>;
  react(target: MessageRef | 'request', reaction: CanonicalReaction): Promise<void>;
  /** Move the source item (label / transition / workflow state). No-op where unsupported. */
  setPhase(phase: Phase): Promise<void>;
  /** Render buttons (Slack) or instructions ("reply /approve or /reject"). Decision arrives via intake. */
  askApproval(req: ApprovalRequest): Promise<MessageRef>;
}

export interface ConversationFactory {
  open(ref: ConversationRef): Conversation;
}

/** Intake side: every adapter emits normalized events into one queue. */
export type InboundEvent =
  | { kind: 'work_request'; source: SourceKind; externalId: string; version: string; title: string; body: string;
      requestedBy: string; ref: ConversationRef; receivedAt: Date }
  | { kind: 'followup'; ref: ConversationRef; author: string; body: string; externalId: string }
  | { kind: 'approval'; decision: ApprovalDecision }
  | { kind: 'cancel'; ref: ConversationRef; by: string };
```

**Per-source implementation map**

| Operation | Slack | Jira Cloud | GitHub | Linear (comments) | Linear (Agent session) | Gmail |
|---|---|---|---|---|---|---|
| `post` | `chat.postMessage` (no `thread_ts`) | `POST …/issue/{k}/comment` (ADF) | `POST …/issues/{n}/comments` | `commentCreate` | `agentActivityCreate` `response` | `messages.send` (`threadId`) |
| `reply` | `chat.postMessage` + `thread_ts` (+ `reply_broadcast` if `notify`) | Comment (flat) | Comment (flat), or `…/pulls/{n}/comments/{id}/replies` for inline threads | `commentCreate` + `parentId` | `thought` / `response` activity | `messages.send` |
| `update` | `chat.update` | `PUT …/comment/{id}` | `PATCH …/issues/comments/{id}` | `commentUpdate` | n/a (append-only) → `agentSessionUpdate.summary`/`plan` | n/a, so send a new email |
| `setStatus` | Update the stored status `ts` | Update the stored status comment + issue property | Update the marker comment + commit status on the PR head | Update the stored comment | `agentSessionUpdate.plan` / ephemeral `thought` | Only on phase change |
| `react` | `reactions.add`/`remove` | Not exposed in REST [U] → no-op | `POST …/issues/{n}/reactions` (`eyes`, `rocket`, `+1`, `-1`, …) | `reactionCreate` | n/a | n/a |
| `setPhase` | n/a (reaction only) | Transition by status category + label | Labels (`factory:working`, …) | `issueUpdate.stateId` + labels | Automatic from activities | Labels |
| `askApproval` | Block Kit buttons (`block_actions`) | Comment "reply `/approve <id>` or `/reject <id>`", then poll comments; optionally a transition to an "Approved" status | Same comment protocol, or `+1`/`-1` reactions on the bot comment (`GET …/issues/comments/{id}/reactions`), or a PR review | Comment protocol | `elicitation` activity; user reply arrives as `prompted` | Reply-with-keyword |

Canonical reactions map: `seen` → Slack `eyes` / GitHub `eyes`; `working` → `hourglass_flowing_sand` / `rocket`; `success` → `white_check_mark` / `hooray`; `failure` → `x` / `confused`.

**Rendering.** Keep `StatusUpdate` source-neutral and render per adapter: Slack `mrkdwn` (escape `& < >`), Jira ADF (`textToAdf`), GitHub GFM, Linear Markdown. Truncate to per-source limits (Slack text ~4,000 recommended, `markdown_text` 12,000).

**Approval security.** An approval is valid only if its `approvalId` is pending and unexpired, **and** the decider is in `approvers`: the Slack `user.id`, Jira `accountId`, GitHub login with write access, or Linear user id. Comment-based approvals must come from a *new* comment by an approver; never from text the agent itself posted, and never from text inside the ticket body.

---

## 9. Security

### 9.1 Webhook signature verification

| Provider | Header(s) | Algorithm | Replay / dedupe | Ack deadline |
|---|---|---|---|---|
| Slack | `X-Slack-Signature`, `X-Slack-Request-Timestamp` | `v0=` + hex HMAC-SHA256(signing secret, `v0:{ts}:{raw}`) | Reject when \|now−ts\| > 5 min; dedupe `event_id` | 3 s [V] |
| GitHub | `X-Hub-Signature-256` | `sha256=` + hex HMAC-SHA256(secret, raw) | Dedupe `X-GitHub-Delivery` | 10 s [V] |
| Jira (admin webhook with secret) | `X-Hub-Signature` | `sha256=` + hex HMAC (method=signature) [V] | Dedupe `X-Atlassian-Webhook-Identifier` | Retries on 408/409/425/429/5xx |
| Linear | `Linear-Signature`, `Linear-Timestamp` | hex HMAC-SHA256(secret, raw) | `webhookTimestamp` within 60 s; dedupe `Linear-Delivery` | 5 s [V] |
| Sentry | `Sentry-Hook-Signature` | hex HMAC-SHA256(client secret, raw) | `Sentry-Hook-Timestamp` | 1 s [V] |
| Gmail Pub/Sub push | `Authorization: Bearer <Google-signed OIDC JWT>` | Verify the JWT (aud, email) [U] | Pub/Sub message id | n/a. Prefer **pull**, which needs no endpoint. |

```ts
// verify.ts: webhook signature checks. Always verify against the RAW body bytes, before JSON.parse.
import { createHmac, timingSafeEqual } from 'node:crypto';

const hmacHex = (secret: string, raw: Buffer | string) => createHmac('sha256', secret).update(raw).digest('hex');
const safeEqual = (a: string, b: string) => {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
};
type H = { get(name: string): string | null };

export const verify = {
  /** Slack: v0=HMAC_SHA256(secret, "v0:{ts}:{raw}"), reject if |now - ts| > 300 s. */
  slack(raw: Buffer, h: H, secret: string) {
    const ts = h.get('x-slack-request-timestamp') ?? '';
    if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    return safeEqual('v0=' + hmacHex(secret, Buffer.concat([Buffer.from(`v0:${ts}:`), raw])), h.get('x-slack-signature') ?? '');
  },
  /** GitHub: X-Hub-Signature-256: sha256=<hex>. Dedupe on X-GitHub-Delivery. */
  github(raw: Buffer, h: H, secret: string) {
    return safeEqual('sha256=' + hmacHex(secret, raw), h.get('x-hub-signature-256') ?? '');
  },
  /** Jira admin webhook with a secret: X-Hub-Signature: sha256=<hex>. Dedupe on X-Atlassian-Webhook-Identifier. */
  jira(raw: Buffer, h: H, secret: string) {
    return safeEqual('sha256=' + hmacHex(secret, raw), h.get('x-hub-signature') ?? '');
  },
  /** Linear: Linear-Signature = hex HMAC of raw body; then webhookTimestamp (ms) within 60 s. Dedupe on Linear-Delivery. */
  linear(raw: Buffer, h: H, secret: string) {
    if (!safeEqual(hmacHex(secret, raw), h.get('linear-signature') ?? '')) return false;
    const { webhookTimestamp } = JSON.parse(raw.toString('utf8')) as { webhookTimestamp: number };
    return Math.abs(Date.now() - webhookTimestamp) <= 60_000;
  },
  /** Sentry integration platform: Sentry-Hook-Signature = hex HMAC(client secret, raw body). */
  sentry(raw: Buffer, h: H, secret: string) {
    return safeEqual(hmacHex(secret, raw), h.get('sentry-hook-signature') ?? '');
  },
};

// Self-test with GitHub's published vector.
if (import.meta.main) {
  const ok = verify.github(Buffer.from('Hello, World!'),
    new Headers({ 'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17' }),
    "It's a Secret to Everybody");
  console.log('github vector', ok ? 'OK' : 'FAIL');
}
```

### 9.2 Ingress hardening (Cloudflare tunnel)

- Expose only `/hooks/<provider>` paths through `cloudflared` ingress rules, and keep everything else on `127.0.0.1`. Put the manual form behind **Cloudflare Access**; provider webhooks can't do Access logins, so rely on HMAC for them.
- Limit body size (e.g. 1 MB), read the raw bytes, verify, ack **before** heavy work, and enqueue only the entity id (the webhook-as-hint pattern).
- Optional: allowlist source IPs (GitHub's `GET https://api.github.com/meta` → `hooks`; Linear's published IPs).
- Rotate webhook secrets. Support two active secrets during rotation by trying both.

### 9.3 Prompt injection from ticket text

Ticket titles and descriptions, comments, Slack messages, emails, PR review comments, CI logs and linked pages are **attacker-controllable input** that will reach an LLM with tools. Mitigations, in priority order:

1. **Authorize the trigger, not the text.** Act only when an allowlisted principal performed the trigger action: who applied the label (Jira changelog, GitHub `labeled` event, Linear history), who mentioned or reacted (Slack `user`), and who delegated (Linear). Text that says "the admin approved this" counts for nothing.
2. **Separate instructions from data.** Wrap ticket content in clearly delimited "untrusted content" sections, and tell the model it may not change its goals, tools or approval rules from them. Strip or flag hidden content: HTML comments in GitHub Markdown, zero-width and bidi characters, collapsed `<details>`, ADF nodes the UI hides, and image alt text.
3. **Least-capability agents.** The agent sandbox gets a repo checkout and a scoped git credential for *its branch* only. **No provider tokens.** It asks the service (a broker) to post updates, and the broker enforces templates, length limits and destination (only the originating conversation). Restrict network egress to a package-registry allowlist.
4. **Human gates.** Require `askApproval` before merging, deploying, touching secrets or CI config (`.github/workflows/**`), or any change outside the declared scope. Run with draft PRs by default.
5. **Output hygiene.** Scan outgoing messages and PR bodies for secrets (token regexes such as `xox[abpr]-`, `xapp-`, `ghp_`/`github_pat_`, `ATATT`, `lin_api_`) and block them. Escape Slack control sequences. Never echo `<!channel>`.
6. **Feedback-loop injection.** Treat PR review comments and CI logs as untrusted too. Only re-engage on comments from users with write permission.
7. **Rate-limit and quota per requester** so a malicious ticket can't trigger unbounded runs.

### 9.4 Least-privilege credentials

| Provider | Credential | Minimum |
|---|---|---|
| Slack | Bot `xoxb-` + app `xapp-` | Scopes in §1.3 only. Install as an internal app in one workspace. Invite the bot only to intake channels. |
| Jira | Scoped API token on a **dedicated account** | `read:jira-work`, `write:jira-work`. Project permissions limited to Browse, Add comments, Edit and Transition in intake projects. Set a token expiry and a renewal reminder. |
| GitHub | Fine-grained PAT (only selected repos) → GitHub App later | Issues RW, Pull requests RW, Contents RW, Commit statuses RW, Metadata R. Add branch protection so the bot can't push to `main` or approve its own PRs. |
| Linear | API key of a bot member → OAuth `actor=app` | `read`, `write` (or `comments:create` / `issues:create`); `app:assignable` / `app:mentionable` only if you use Agents. Never `admin`. |
| Gmail | OAuth refresh token | `gmail.modify` + `gmail.send`, or `gmail.readonly`. Use a dedicated mailbox if possible. |

### 9.5 Storing tokens encrypted at rest (macOS)

- Keep a 256-bit master key in the **login Keychain** (`/usr/bin/security find-generic-password -s software-factory -a master-key -w`). Store tokens in SQLite as **AES-256-GCM** ciphertext, with AAD set to the secret's name. This keeps plaintext out of `.env`, backups and Time Machine.
- Never log `Authorization` headers. Redact token patterns in error messages. Make the DB file `chmod 600`.
- Rotating credentials (Atlassian refresh tokens, Slack rotation if you enable `token_rotation_enabled`, GitHub App installation tokens) must be written back atomically before use.
- Rotate on a schedule: Jira tokens expire within 365 days anyway, and fine-grained PATs carry an expiry.

```ts
// secrets.ts: tokens encrypted at rest. Master key lives in the macOS login Keychain; ciphertext lives in SQLite.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const run = promisify(execFile);
const SERVICE = 'software-factory', ACCOUNT = 'master-key';

async function masterKey(): Promise<Buffer> {
  try {
    const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    return Buffer.from(stdout.trim(), 'base64');
  } catch {
    const key = randomBytes(32);
    // -U updates if it exists. Note: argv is briefly visible to other local processes via `ps`; run once at setup.
    await run('/usr/bin/security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', key.toString('base64'), '-U']);
    return key;
  }
}

/** AES-256-GCM; output = base64(iv | tag | ciphertext). `aad` binds the blob to its name (e.g. "slack.bot_token"). */
export async function seal(plaintext: string, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await masterKey(), iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export async function open(sealed: string, aad: string): Promise<string> {
  const b = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', await masterKey(), b.subarray(0, 12)).setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
```

---

## 10. Unverified or conflicting items to test first

1. Slack: whether the 2025 Tier 1 limit on `conversations.history`/`conversations.replies` now applies to **existing** installs of unlisted apps (the changelog says no; snippets of revised versions say from 2026-03-03). It's irrelevant if the app stays internal.
2. Slack: the Socket Mode ack deadline (assumed 3 s), and `conversations.replies` behavior when given a thread-reply `ts`.
3. Jira: the exact final shutdown date of `/rest/api/3/search` (CHANGE-2046; observed as 410). The scoped-token `cloudId` lookup via `/_edge/tenant_info`. JQL time-zone interpretation. Whether issue properties are JQL-searchable without an app. Signing of dynamic (OAuth) webhooks. Data Center PAT version, search API and EOL dates.
4. GitHub: whether fine-grained PATs can read `GET /commits/{ref}/check-runs` (docs conflict). Whether `reviewDecision` is null without review rules. Webhook `review.state` casing. The search API limit.
5. Linear: the OAuth URLs, the emoji format for `reactionCreate`, deduplication semantics of client-supplied comment `id`, signal semantics (`select`, `stop`), and API key permission scoping.
6. Gmail: the 7-day refresh-token expiry in Testing mode, and Pub/Sub push JWT verification details.
7. Sentry: the polling endpoint and query syntax.

---

## 11. Sources (fetched 2026-10-30)

- Slack: [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode) · [apps.connections.open](https://docs.slack.dev/reference/methods/apps.connections.open) · [Events API](https://docs.slack.dev/apis/events-api/) · [Verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack) · [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits) · [2025-05-29 rate-limit changes for non-Marketplace apps](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps) · [JA FAQ](https://docs.slack.dev/ja-jp/2025-05-terms-rate-limit-update-and-faq) · [conversations.history](https://docs.slack.dev/reference/methods/conversations.history) · [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage) · [chat.update](https://docs.slack.dev/reference/methods/chat.update) · [chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream) · [reactions.add](https://docs.slack.dev/reference/methods/reactions.add) · [app_mention](https://docs.slack.dev/reference/events/app_mention) · [reaction_added](https://docs.slack.dev/reference/events/reaction_added) · [block_actions payload](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload) · [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction) · [App manifest reference](https://docs.slack.dev/reference/app-manifest) · [@slack/socket-mode README](https://github.com/slackapi/node-slack-sdk/tree/main/packages/socket-mode) (and the 3.1.1 package source)
- Atlassian: [Jira Cloud OpenAPI v3](https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json) (search/jql, comment, transitions, properties, webhook operations) · [Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/) · [Basic auth](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/) · [OAuth 2.0 (3LO)](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) · [Webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/) · [Manage API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) · [Changelog](https://developer.atlassian.com/changelog/#CHANGE-2046) · [Community: 410 on /search](https://github.com/atlassian/atlassian-mcp-server/issues/70) · [Data Center EOL (Atlassian blog)](https://www.atlassian.com/blog/developer/from-data-center-to-cloud-the-next-chapter-for-marketplace-apps)
- GitHub: [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions) · [Breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes) · [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) · [Best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) · [Issues](https://docs.github.com/en/rest/issues/issues) · [PR review comments](https://docs.github.com/en/rest/pulls/comments) · [Check runs](https://docs.github.com/en/rest/checks/runs) · [Fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) · [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) · [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) · [Community: no Checks permission for fine-grained PATs](https://github.com/orgs/community/discussions/179545) · `gh` 2.87.3 `--help`
- Linear: [GraphQL API](https://linear.app/developers/graphql) · [Filtering](https://linear.app/developers/filtering) · [Rate limiting](https://linear.app/developers/rate-limiting) · [Webhooks](https://linear.app/developers/webhooks) · [Agents: Getting started](https://linear.app/developers/agents) · [Agent interaction](https://linear.app/developers/agent-interaction) · [SDK schema.graphql](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)
- Google: [Gmail sync guide](https://developers.google.com/workspace/gmail/api/guides/sync) · [users.history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) · [Push notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- Other: [croner README](https://github.com/Hexagon/croner) and [CHANGELOG](https://raw.githubusercontent.com/Hexagon/croner/master/CHANGELOG.md) · [Sentry integration webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/)
