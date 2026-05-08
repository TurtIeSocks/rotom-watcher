# Discord Webhooks — Design

## Goal

Add an opt-in Discord webhook integration that emits richly-formatted, scannable embeds for operationally significant events. Operators choose which events fire by listing them in config; nothing fires by default.

## Configuration

### TOML shape

```toml
[webhooks]
discord                = []          # Discord webhook URLs
events                 = []          # event names to enable; empty = disabled
mention_role_id        = ""          # role pinged ONLY on Critical events
coalesce_window_ms     = 10000       # 0 disables coalescing
retry_attempts         = 3           # POST retries on 5xx/timeout/429
retry_initial_delay_ms = 500         # exponential backoff base, ×2 per attempt
username               = "rotom-watcher"
avatar_url             = ""          # empty = no avatar override
```

The `[webhooks]` section is optional. If `discord` is empty OR `events` is empty, the dispatcher is a no-op and all `emit()` calls return immediately.

### `config.toml.example`

The example file lists every event name as a commented entry so operators can uncomment what they want:

```toml
[webhooks]
discord = []
events = [
  # "origin.offline.restart",
  # "origin.offline.update",
  # "origin.recovered",
  # "script.succeeded",
  # "script.failed",
  # "script.timed_out",
  # "circuit_breaker.opened",
  # "circuit_breaker.half_open",
  # "circuit_breaker.closed",
  # "queue.saturated",
  # "poll.failed",
  # "device.duplicate_deleted",
  # "group.pipeline.triggered",
  # "service.started",
  # "service.stopping",
]
mention_role_id        = ""
coalesce_window_ms     = 10000
retry_attempts         = 3
retry_initial_delay_ms = 500
username               = "rotom-watcher"
avatar_url             = ""
```

### Environment variables

Added to `fileConfigMappings` in `src/config/schema.ts`:

| Env | TOML path |
|---|---|
| `WEBHOOKS_DISCORD` | `webhooks.discord` (comma-separated) |
| `WEBHOOKS_EVENTS` | `webhooks.events` (comma-separated) |
| `WEBHOOKS_MENTION_ROLE_ID` | `webhooks.mention_role_id` |
| `WEBHOOKS_COALESCE_WINDOW_MS` | `webhooks.coalesce_window_ms` |
| `WEBHOOKS_RETRY_ATTEMPTS` | `webhooks.retry_attempts` |
| `WEBHOOKS_RETRY_INITIAL_DELAY_MS` | `webhooks.retry_initial_delay_ms` |
| `WEBHOOKS_USERNAME` | `webhooks.username` |
| `WEBHOOKS_AVATAR_URL` | `webhooks.avatar_url` |

Comma-split rule: Discord webhook URLs do not contain commas, so `https://discord.com/api/webhooks/A,https://discord.com/api/webhooks/B` is unambiguous.

### Resulting `Config` extension

```ts
webhooks: {
  discordUrls: string[];          // [] = disabled
  events: ReadonlySet<EventName>; // empty = disabled
  mentionRoleId: string;          // "" = no mention
  coalesceWindowMs: number;       // 0 = no coalescing
  retryAttempts: number;          // 0 = single attempt, no retries
  retryInitialDelayMs: number;
  username: string;
  avatarUrl: string;              // "" = no override
};
```

### Validation (Zod)

- `discord`: each entry must parse as a valid HTTPS URL (matches the `ROTOM_API_BASE_URL` validator).
- `events`: each entry must be in the catalog — `z.enum([...EVENT_NAMES])`. Unknown names produce an error listing valid names.
- `mention_role_id`: optional; if non-empty, must match `/^\d+$/` (Discord snowflake).
- `coalesce_window_ms`: integer ≥ 0. (Distinct from `positiveInteger`; 0 is meaningful = disabled.)
- `retry_attempts`: integer ≥ 0.
- `retry_initial_delay_ms`: positive integer.
- `username`: 1–80 characters (Discord limit).
- `avatar_url`: optional; if set, must be HTTPS.

## Event catalog

15 events across 4 severity tiers. Severity controls the embed color and whether `mention_role_id` is pinged.

| Event | Severity | Subject | Emitted at |
|---|---|---|---|
| `origin.offline.restart` | Warning | origin name | `device-monitor.ts` when an origin enters offline state and `getScriptMode()` returns `restart` |
| `origin.offline.update` | Critical | origin name | `device-monitor.ts` when an origin enters offline state and `getScriptMode()` returns `update` (i.e., escalated past `restart_threshold`) |
| `origin.recovered` | Success | origin name | `origin-state.ts` when `cleanupOnlineOrigins` removes a previously-tracked origin |
| `script.succeeded` | Success | origin name | `script-runner.ts` on successful script exit |
| `script.failed` | Critical | origin name | `script-runner.ts` after all retries exhausted |
| `script.timed_out` | Warning | origin name | `script-runner.ts` when a script is killed for exceeding `scriptTimeoutMs` |
| `circuit_breaker.opened` | Critical | `rotom-api` | `circuit-breaker.ts` on transition to OPEN |
| `circuit_breaker.half_open` | Warning | `rotom-api` | `circuit-breaker.ts` on transition to HALF_OPEN |
| `circuit_breaker.closed` | Success | `rotom-api` | `circuit-breaker.ts` on transition back to CLOSED |
| `queue.saturated` | Critical | `job-queue` | `job-queue.ts` first time the queue rejects a job within a quiet window (avoids spam) |
| `poll.failed` | Warning | `rotom-api` | `device-monitor.ts` when a poll cycle fails |
| `device.duplicate_deleted` | Info | origin name | `device-monitor.ts` after a duplicate-device deletion |
| `group.pipeline.triggered` | Info | origin name | `device-monitor.ts` when the group recovery pipeline fires |
| `service.started` | Info | `rotom-watcher` | `index.ts` after dependencies initialize |
| `service.stopping` | Info | `rotom-watcher` | `index.ts` on shutdown signal |

### Severity → color

| Severity | Hex | Decimal (Discord) |
|---|---|---|
| Critical | `#ed4245` | `15548997` |
| Warning  | `#faa61a` | `16426522` |
| Success  | `#57f287` | `5763719`  |
| Info     | `#5865f2` | `5793266`  |

### Severity emoji

Used in embed titles: `🔥 CRITICAL`, `⚠️ WARNING`, `✅ SUCCESS`, `ℹ️ INFO`.

### Event payload contracts

`WebhookEvent` is a discriminated union keyed on `name`:

```ts
type WebhookEvent =
  | { name: "origin.offline.restart";    subject: string;            fields: { mode: "restart"; attempt: number; devices: number; lastSeenMs: number } }
  | { name: "origin.offline.update";     subject: string;            fields: { mode: "update";  offlineStreak: number; devices: number; lastSeenMs: number } }
  | { name: "origin.recovered";          subject: string;            fields: { downForMs: number; lastScript: ScriptMode; result: "success" | "unknown"; devices: number } }
  | { name: "script.succeeded";          subject: string;            fields: { mode: ScriptMode; durationMs: number; attempt: number; runId: string } }
  | { name: "script.failed";             subject: string;            fields: { mode: ScriptMode; exitCode: number | null; attempts: number; durationMs: number; runId: string } }
  | { name: "script.timed_out";          subject: string;            fields: { mode: ScriptMode; timeoutMs: number; attempt: number; runId: string } }
  | { name: "circuit_breaker.opened";    subject: "rotom-api";       fields: { failures: number; threshold: number; resetMs: number } }
  | { name: "circuit_breaker.half_open"; subject: "rotom-api";       fields: { resetMs: number } }
  | { name: "circuit_breaker.closed";    subject: "rotom-api";       fields: Record<string, never> }
  | { name: "queue.saturated";           subject: "job-queue";       fields: { capacity: number; queued: number; running: number; rejected: number } }
  | { name: "poll.failed";               subject: "rotom-api";       fields: { reason: string; durationMs: number } }
  | { name: "device.duplicate_deleted";  subject: string;            fields: { deviceId: string; origin: string } }
  | { name: "group.pipeline.triggered";  subject: string;            fields: { groupSize: number; trigger: string } }
  | { name: "service.started";           subject: "rotom-watcher";   fields: { version: string; origins: number; pollIntervalMs: number; concurrency: number; pid: number } }
  | { name: "service.stopping";          subject: "rotom-watcher";   fields: { reason: string; runningJobs: number; queuedJobs: number } };
```

## Architecture

### Module layout

New files under `src/webhooks/`:

| File | Purpose |
|---|---|
| `types.ts` | `WebhookEvent`, `EventName`, `Severity`, `WebhookField` types |
| `events.ts` | `EVENT_NAMES` constant, `SEVERITY` map, default event metadata |
| `dispatcher.ts` | `WebhookDispatcher` — filters, coalesces, hands batches to transports |
| `discord-transport.ts` | Renders `WebhookEvent` → Discord embed JSON, POSTs with retry policy |
| `dispatcher.test.ts`, `discord-transport.test.ts`, `events.test.ts` | Unit tests |

Touched files:

- `src/config/schema.ts` — extend `Config`, Zod schema, env mappings
- `src/observability/metrics.ts` — three new counters
- `src/index.ts` — instantiate dispatcher, wire into existing components, emit `service.started`/`service.stopping`
- `src/monitor/device-monitor.ts`, `src/monitor/origin-state.ts`, `src/runtime/script-runner.ts`, `src/runtime/circuit-breaker.ts`, `src/runtime/job-queue.ts` — accept dispatcher in deps; emit events at the relevant moments (logging is unchanged)
- `config.toml.example` — add the `[webhooks]` block above
- `README.md` — add a Webhooks section with the event reference

### Data flow

```
emit site (e.g. script-runner)
   │
   ├── logger.info(...)            (unchanged)
   └── dispatcher.emit(event)      (new)
            │
            ▼
      WebhookDispatcher
       (filters by config.webhooks.events; no-op if disabled)
            │
            ▼
      Coalescing buffer
       (key = event.name, window = coalesceWindowMs)
            │  flush
            ▼
      DiscordTransport.send(batch)
            │
            ▼
      Render → embed JSON → fetch POST → retry on 5xx/timeout/429
            │
            ▼
      metrics: delivered | failed | coalesced
```

### Isolation

- **Emit sites** depend only on `dispatcher.emit(event)`. They know nothing about Discord or formatting.
- **Dispatcher** owns filtering, coalescing, shutdown flush. It knows nothing about the wire format.
- **Transport** owns rendering and POSTing. It knows nothing about emit sites or business logic.
- Each piece is unit-testable with fakes — fake transport for the dispatcher, fake `fetch` for the transport.

## Renderer

### Per-event renderer

Each event has a renderer that returns a Discord embed object. Renderers live in a single map in `discord-transport.ts`:

```ts
type Renderer<E extends WebhookEvent> = (e: E) => DiscordEmbed;

const RENDERERS: { [N in EventName]: Renderer<Extract<WebhookEvent, { name: N }>> } = {
  "script.failed": (e) => ({
    color: 0xed4245,
    title: `🔥 CRITICAL · ${e.name} | ${e.subject}`,
    description: `Origin **${e.subject}** could not be recovered after retries.`,
    fields: [
      { name: "Mode",  value: `\`${e.fields.mode}\``,                 inline: true },
      { name: "Exit",  value: e.fields.exitCode?.toString() ?? "—",   inline: true },
      { name: "Tries", value: e.fields.attempts.toString(),           inline: true },
      { name: "Took",  value: formatDuration(e.fields.durationMs),    inline: true },
    ],
    footer: { text: `run ${e.fields.runId} • ${formatTimestamp()}` },
  }),
  // ... one entry per event in EVENT_NAMES
};
```

The Hero "banner gradient" from the visual mockup is implemented as a Discord embed `title` (Discord doesn't support custom HTML banners). The severity color appears as the standard left-edge stripe via the embed `color` field. The banner formula `[severity-emoji] [SEVERITY] · {event.name} | {subject}` carries over verbatim into the title.

### Coalesced embed format

When N≥2 events of the same name fire within `coalesceWindowMs`:

- `title`: `[severity-emoji] [SEVERITY] · {event.name} (×N) | multiple subjects`
- `description`: short summary, e.g. `4 origins escalated to update mode in the last 10s.`
- `fields`: replaced with one `Subjects` field listing unique subjects, comma-separated, truncated to 20 entries with `+ N more` suffix to stay under Discord's 1024-char field limit.
- `footer`: window timing — `coalesced over 10s • 14:32 UTC`.

Coalesce key is `event.name` only. Different subjects under the same event name merge into one batch (the regional-outage case). Different event names stay separate.

### Identity

Every POST body includes:

```json
{
  "username": "rotom-watcher",
  "avatar_url": "<from config, omitted if empty>",
  "embeds": [...]
}
```

### Mentions

Critical events add:

```json
{
  "content": "<@&{mention_role_id}>",
  "allowed_mentions": { "roles": ["{mention_role_id}"] }
}
```

If `mention_role_id` is empty, no `content` and no `allowed_mentions` are sent. Non-critical events never include `content`. `allowed_mentions.roles` scopes the mention so a runaway payload cannot accidentally `@everyone`.

## Dispatcher policies

### Filtering

On `emit(event)`:

1. If `discordUrls` is empty OR `event.name` is not in the enabled `events` set → return immediately (no allocation).
2. Otherwise push into the coalescing buffer.

### Coalescing buffer

Internally a `Map<EventName, BufferedBatch>`. The first event for a name starts a `setTimeout(coalesceWindowMs)`. When the timer fires, the batch is flushed to the transport and the buffer entry is cleared.

`coalesceWindowMs = 0` → flush synchronously, never buffer.

### Retry policy

`DiscordTransport.send(batch)` POSTs to each URL in parallel. Per URL:

- Attempt 1 → on `5xx`, network error, timeout, or `429`: wait `retryInitialDelayMs × 2^n`, retry up to `retryAttempts` times.
- `429` honors the `Retry-After` header when present (overrides exponential delay).
- `4xx` other than `429`: log + drop, no retry. These are config errors (bad URL, payload too big) that won't fix on retry.
- After all retries fail: increment `webhook_events_failed_total` with appropriate `reason` label, log error.

### Shutdown

On SIGTERM, dispatcher flushes pending coalesce buffers before resolving. Bounded by the existing `shutdownGracePeriodMs`. If flush exceeds the budget, drop the remaining buffer with a logged warning.

## Metrics

Three new counters in `src/observability/metrics.ts`:

| Metric | Labels | When |
|---|---|---|
| `webhook_events_delivered_total` | `event`, `severity` | Per successful POST (one increment per URL) |
| `webhook_events_failed_total` | `event`, `reason` | After all retries exhausted; `reason` ∈ `timeout \| 5xx \| 429_exhausted \| 4xx \| network` |
| `webhook_events_coalesced_total` | `event` | Per event merged into a coalesced batch (i.e., everything beyond the first per batch) |

## Testing

### `events.test.ts`

- The `SEVERITY` map covers every `EventName`. Compile-time exhaustiveness via `satisfies Record<EventName, Severity>`, plus a runtime test asserting `Object.keys(SEVERITY).length === EVENT_NAMES.length`.
- `EVENT_NAMES` array stays in sync with the `WebhookEvent` union via a type-level assertion test.

### `dispatcher.test.ts`

Fake transport that records calls. A fake clock (injected via deps) lets tests advance time without real waits.

- `emit` is a no-op when `discordUrls` is empty.
- `emit` is a no-op when `event.name` is not in the enabled set.
- Single event flushes after `coalesceWindowMs` as a single-event batch.
- Two events of the same name within the window flush as one coalesced batch carrying both subjects.
- Two events of different names within the window flush as two separate batches.
- `coalesceWindowMs = 0` flushes synchronously, no batching.
- `flush()` (shutdown path) drains pending buffers immediately.

### `discord-transport.test.ts`

Fake `fetch` injected through deps.

- Single event renders correct embed JSON for every event in the catalog (table-driven; one row per event in `EVENT_NAMES`).
- Coalesced batch renders the merged format with subject list and `+ N more` truncation past 20 subjects.
- Critical events include `content` with role mention and `allowed_mentions: { roles: [id] }`.
- Non-critical events have no `content` and no `allowed_mentions`.
- `username` and `avatar_url` propagate to body when set; `avatar_url` is omitted when empty.
- 5xx response triggers retry up to `retryAttempts` with exponential backoff (assert call timings via fake clock).
- 429 with `Retry-After` honors the header.
- 4xx other than 429 drops without retry; metric incremented with `reason: "4xx"`.
- All retries exhausted increments metric with the appropriate `reason`.
- POSTs to all `discordUrls` happen in parallel (assert simultaneous in-flight calls).

### `config/schema.test.ts` additions

- Valid TOML/env shapes parse correctly.
- Unknown event name produces an error listing valid names.
- Non-HTTPS Discord URL rejected.
- Comma-split `WEBHOOKS_DISCORD` env var produces an array.
- Empty `events` + non-empty `discord` (and vice versa) parse as the disabled state without error.
- `coalesce_window_ms = 0` accepted (distinct from `positiveInteger` validators).

### Integration coverage

`device-monitor.test.ts`, `script-runner.test.ts`, `circuit-breaker.test.ts`, `job-queue.test.ts` each get one new test asserting that the right event name is emitted at the right moment, using a fake dispatcher captured at construction time.

## Out of scope

- Slack, generic webhook, or other transports (the `WebhookDispatcher` interface is shaped to support them later, but no other transport is implemented in this iteration).
- Per-URL event filtering (all `discord` URLs receive the same enabled events).
- Per-event mention configuration (only Critical mentions, only one role).
- Custom embed templates / user-overridable rendering.
- Persistent / on-disk delivery queue (failed events are dropped after retries).
