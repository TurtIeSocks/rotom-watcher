# Discord Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Discord webhook integration that emits richly-formatted, scannable embeds for 15 operational events.

**Architecture:** A new `src/webhooks/` module containing a `WebhookDispatcher` (filtering + coalescing) and a `DiscordTransport` (rendering + POST with retry). Existing modules emit typed events to the dispatcher via dependency injection — no Discord knowledge leaks into business logic.

**Tech Stack:** TypeScript, Bun, Zod for validation, `bun:test` for tests, `prom-client` for metrics, native `fetch` for HTTP. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-04-discord-webhooks-design.md](../specs/2026-05-04-discord-webhooks-design.md)

**Codebase conventions to follow:**
- Tab indentation, double quotes (Biome enforces).
- Object keys are sorted alphabetically (Biome `organizeImports` + assist).
- Tests live next to source: `foo.ts` + `foo.test.ts`.
- Pino logger argument order: `logger.info({ key: val }, "message")`.
- Metric names: `rotom_watcher_<thing>_total` (snake_case).
- Dependency injection style: classes take deps in their constructor; tests inject fakes.
- Time and randomness are injected (see `now: () => number` in [circuit-breaker.ts:16](src/runtime/circuit-breaker.ts:16) and `random: () => number` in [script-runner.ts:30](src/runtime/script-runner.ts:30)).

**Run after every task:**
- `bun test` — full suite must pass.
- `bun run typecheck` — `tsc --noEmit`, must pass with zero errors.
- `bun run lint` — Biome, must pass.

---

## Task 1: Event types and catalog

**Files:**
- Create: `src/webhooks/types.ts`
- Create: `src/webhooks/events.ts`
- Test: `src/webhooks/events.test.ts`

This task establishes the data contracts. It has no behavior — just types and constants — so it's the safest place to start.

- [ ] **Step 1: Create `src/webhooks/types.ts`**

```typescript
import type { ScriptMode } from "../monitor/types";

export type Severity = "critical" | "warning" | "success" | "info";

export type EventName =
	| "circuit_breaker.closed"
	| "circuit_breaker.half_open"
	| "circuit_breaker.opened"
	| "device.duplicate_deleted"
	| "group.pipeline.triggered"
	| "origin.offline.restart"
	| "origin.offline.update"
	| "origin.recovered"
	| "poll.failed"
	| "queue.saturated"
	| "script.failed"
	| "script.succeeded"
	| "script.timed_out"
	| "service.started"
	| "service.stopping";

export type WebhookEvent =
	| {
			fields: {
				devices: number;
				lastSeenMs: number;
				mode: "restart";
				attempt: number;
			};
			name: "origin.offline.restart";
			subject: string;
	  }
	| {
			fields: {
				devices: number;
				lastSeenMs: number;
				mode: "update";
				offlineStreak: number;
			};
			name: "origin.offline.update";
			subject: string;
	  }
	| {
			fields: {
				devices: number;
				downForMs: number;
				lastScript: ScriptMode;
				result: "success" | "unknown";
			};
			name: "origin.recovered";
			subject: string;
	  }
	| {
			fields: {
				attempt: number;
				durationMs: number;
				mode: ScriptMode;
				runId: string;
			};
			name: "script.succeeded";
			subject: string;
	  }
	| {
			fields: {
				attempts: number;
				durationMs: number;
				exitCode: number | null;
				mode: ScriptMode;
				runId: string;
			};
			name: "script.failed";
			subject: string;
	  }
	| {
			fields: {
				attempt: number;
				mode: ScriptMode;
				runId: string;
				timeoutMs: number;
			};
			name: "script.timed_out";
			subject: string;
	  }
	| {
			fields: {
				failures: number;
				resetMs: number;
				threshold: number;
			};
			name: "circuit_breaker.opened";
			subject: "rotom-api";
	  }
	| {
			fields: { resetMs: number };
			name: "circuit_breaker.half_open";
			subject: "rotom-api";
	  }
	| {
			fields: Record<string, never>;
			name: "circuit_breaker.closed";
			subject: "rotom-api";
	  }
	| {
			fields: {
				capacity: number;
				queued: number;
				rejected: number;
				running: number;
			};
			name: "queue.saturated";
			subject: "job-queue";
	  }
	| {
			fields: { durationMs: number; reason: string };
			name: "poll.failed";
			subject: "rotom-api";
	  }
	| {
			fields: { deviceId: string; origin: string };
			name: "device.duplicate_deleted";
			subject: string;
	  }
	| {
			fields: { groupSize: number; trigger: string };
			name: "group.pipeline.triggered";
			subject: string;
	  }
	| {
			fields: {
				concurrency: number;
				origins: number;
				pid: number;
				pollIntervalMs: number;
				version: string;
			};
			name: "service.started";
			subject: "rotom-watcher";
	  }
	| {
			fields: { queuedJobs: number; reason: string; runningJobs: number };
			name: "service.stopping";
			subject: "rotom-watcher";
	  };

export type WebhookEventOf<N extends EventName> = Extract<
	WebhookEvent,
	{ name: N }
>;

export interface WebhookTransport {
	send(batch: WebhookEvent[]): Promise<void>;
}

export interface WebhookEmitter {
	emit(event: WebhookEvent): void;
}
```

- [ ] **Step 2: Create `src/webhooks/events.ts`**

```typescript
import type { EventName, Severity } from "./types";

export const EVENT_NAMES = [
	"circuit_breaker.closed",
	"circuit_breaker.half_open",
	"circuit_breaker.opened",
	"device.duplicate_deleted",
	"group.pipeline.triggered",
	"origin.offline.restart",
	"origin.offline.update",
	"origin.recovered",
	"poll.failed",
	"queue.saturated",
	"script.failed",
	"script.succeeded",
	"script.timed_out",
	"service.started",
	"service.stopping",
] as const satisfies readonly EventName[];

export const SEVERITY = {
	"circuit_breaker.closed": "success",
	"circuit_breaker.half_open": "warning",
	"circuit_breaker.opened": "critical",
	"device.duplicate_deleted": "info",
	"group.pipeline.triggered": "info",
	"origin.offline.restart": "warning",
	"origin.offline.update": "critical",
	"origin.recovered": "success",
	"poll.failed": "warning",
	"queue.saturated": "critical",
	"script.failed": "critical",
	"script.succeeded": "success",
	"script.timed_out": "warning",
	"service.started": "info",
	"service.stopping": "info",
} as const satisfies Record<EventName, Severity>;

export const SEVERITY_COLOR: Record<Severity, number> = {
	critical: 0xed4245,
	info: 0x5865f2,
	success: 0x57f287,
	warning: 0xfaa61a,
};

export const SEVERITY_LABEL: Record<Severity, string> = {
	critical: "🔥 CRITICAL",
	info: "ℹ️ INFO",
	success: "✅ SUCCESS",
	warning: "⚠️ WARNING",
};
```

- [ ] **Step 3: Write `src/webhooks/events.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { EVENT_NAMES, SEVERITY, SEVERITY_COLOR, SEVERITY_LABEL } from "./events";
import type { EventName, Severity } from "./types";

describe("event catalog", () => {
	test("EVENT_NAMES has no duplicates", () => {
		const set = new Set<string>(EVENT_NAMES);
		expect(set.size).toBe(EVENT_NAMES.length);
	});

	test("SEVERITY has an entry for every EVENT_NAME", () => {
		for (const name of EVENT_NAMES) {
			expect(SEVERITY[name]).toBeDefined();
		}
		expect(Object.keys(SEVERITY).length).toBe(EVENT_NAMES.length);
	});

	test("every severity has a color and a label", () => {
		const severities: Severity[] = ["critical", "info", "success", "warning"];
		for (const severity of severities) {
			expect(SEVERITY_COLOR[severity]).toBeDefined();
			expect(SEVERITY_LABEL[severity]).toBeDefined();
		}
	});

	test("EVENT_NAMES type is exhaustive over EventName", () => {
		// Compile-time check via assignment: an EventName not present in
		// EVENT_NAMES would fail to satisfy this.
		const names: readonly EventName[] = EVENT_NAMES;
		expect(names.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 4: Run tests, typecheck, lint**

```bash
bun test src/webhooks/events.test.ts
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/webhooks/types.ts src/webhooks/events.ts src/webhooks/events.test.ts
git commit -m "feat(webhooks): add event types and catalog"
```

---

## Task 2: Webhooks config schema

**Files:**
- Modify: `src/config/schema.ts` (extend `Config`, add Zod fields, add env mappings)
- Modify: `src/config/config.test.ts` (or `manager.test.ts` — check which exists; add cases there)

This wires `[webhooks]` into the existing config pipeline so subsequent tasks can read it.

- [ ] **Step 1: Read the existing `Config` interface and Zod schema**

Open [src/config/schema.ts](src/config/schema.ts). Note the alphabetical key order in the `Config` interface and the `fileConfigMappings` array.

- [ ] **Step 2: Add a comma-split helper at the top of `schema.ts` (after `defaultScriptPath`)**

```typescript
const splitCommaList = (value: unknown): unknown => {
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return value;
};
```

- [ ] **Step 3: Import `EVENT_NAMES` and types at the top of `schema.ts`**

```typescript
import { EVENT_NAMES } from "../webhooks/events";
import type { EventName } from "../webhooks/types";
```

- [ ] **Step 4: Extend the `Config` interface (alphabetical order — webhooks slots in after `shutdownGracePeriodMs`)**

```typescript
export interface Config {
	// ... existing fields unchanged ...
	shutdownGracePeriodMs: number;
	webhooks: {
		avatarUrl: string;
		coalesceWindowMs: number;
		discordUrls: string[];
		events: ReadonlySet<EventName>;
		mentionRoleId: string;
		retryAttempts: number;
		retryInitialDelayMs: number;
		username: string;
	};
}
```

- [ ] **Step 5: Add env mappings to `fileConfigMappings`**

Append these entries at the end of the array (before `] as const;`):

```typescript
{
	envKey: "WEBHOOKS_DISCORD",
	path: ["webhooks", "discord"],
},
{
	envKey: "WEBHOOKS_EVENTS",
	path: ["webhooks", "events"],
},
{
	envKey: "WEBHOOKS_MENTION_ROLE_ID",
	path: ["webhooks", "mention_role_id"],
},
{
	envKey: "WEBHOOKS_COALESCE_WINDOW_MS",
	path: ["webhooks", "coalesce_window_ms"],
},
{
	envKey: "WEBHOOKS_RETRY_ATTEMPTS",
	path: ["webhooks", "retry_attempts"],
},
{
	envKey: "WEBHOOKS_RETRY_INITIAL_DELAY_MS",
	path: ["webhooks", "retry_initial_delay_ms"],
},
{
	envKey: "WEBHOOKS_USERNAME",
	path: ["webhooks", "username"],
},
{
	envKey: "WEBHOOKS_AVATAR_URL",
	path: ["webhooks", "avatar_url"],
},
```

- [ ] **Step 6: Add a `nonNegativeInteger` validator helper next to the existing `positiveInteger` and `positiveIntegerWithMinimum`**

```typescript
const nonNegativeInteger = (name: string, defaultValue: number) =>
	z.preprocess(
		(value) => value ?? defaultValue,
		z.coerce
			.number({
				error: `${name} must be a valid number`,
			})
			.int(`${name} must be an integer`)
			.gte(0, `${name} must be at least 0`),
	);
```

- [ ] **Step 7: Add Zod fields inside `configSchema = z.object({...})` (alphabetical key order)**

Insert these alongside the existing fields:

```typescript
WEBHOOKS_AVATAR_URL: z.preprocess(
	(value) => value ?? "",
	z
		.string()
		.refine(
			(value) =>
				value === "" ||
				(() => {
					try {
						const url = new URL(value);
						return url.protocol === "https:";
					} catch {
						return false;
					}
				})(),
			"WEBHOOKS_AVATAR_URL must be empty or a valid HTTPS URL",
		),
),
WEBHOOKS_COALESCE_WINDOW_MS: nonNegativeInteger(
	"WEBHOOKS_COALESCE_WINDOW_MS",
	10_000,
),
WEBHOOKS_DISCORD: z.preprocess(
	(value) => splitCommaList(value) ?? [],
	z
		.array(
			z
				.string()
				.url("WEBHOOKS_DISCORD entries must be valid URLs")
				.refine((value) => {
					try {
						return new URL(value).protocol === "https:";
					} catch {
						return false;
					}
				}, "WEBHOOKS_DISCORD entries must use https"),
		)
		.default([]),
),
WEBHOOKS_EVENTS: z.preprocess(
	(value) => splitCommaList(value) ?? [],
	z.array(z.enum(EVENT_NAMES)).default([]),
),
WEBHOOKS_MENTION_ROLE_ID: z.preprocess(
	(value) => value ?? "",
	z
		.string()
		.refine(
			(value) => value === "" || /^\d+$/.test(value),
			"WEBHOOKS_MENTION_ROLE_ID must be empty or a Discord snowflake (digits only)",
		),
),
WEBHOOKS_RETRY_ATTEMPTS: nonNegativeInteger("WEBHOOKS_RETRY_ATTEMPTS", 3),
WEBHOOKS_RETRY_INITIAL_DELAY_MS: positiveInteger(
	"WEBHOOKS_RETRY_INITIAL_DELAY_MS",
	500,
),
WEBHOOKS_USERNAME: z.preprocess(
	(value) => value ?? "rotom-watcher",
	z
		.string()
		.min(1, "WEBHOOKS_USERNAME must not be empty")
		.max(80, "WEBHOOKS_USERNAME must be at most 80 characters"),
),
```

- [ ] **Step 8: Map the parsed values into the transformed `Config` (inside `.transform(...)`)**

After the existing fields, add:

```typescript
webhooks: {
	avatarUrl: values.WEBHOOKS_AVATAR_URL,
	coalesceWindowMs: values.WEBHOOKS_COALESCE_WINDOW_MS,
	discordUrls: values.WEBHOOKS_DISCORD,
	events: new Set(values.WEBHOOKS_EVENTS),
	mentionRoleId: values.WEBHOOKS_MENTION_ROLE_ID,
	retryAttempts: values.WEBHOOKS_RETRY_ATTEMPTS,
	retryInitialDelayMs: values.WEBHOOKS_RETRY_INITIAL_DELAY_MS,
	username: values.WEBHOOKS_USERNAME,
},
```

- [ ] **Step 9: Identify the existing config test file**

```bash
ls src/config/*.test.ts
```

Open the file (likely `src/config/config.test.ts`) and find a passing test to model after.

- [ ] **Step 10: Add webhook config tests**

Append these tests inside the existing `describe`:

```typescript
test("defaults webhooks block to disabled", () => {
	const config = createConfig({
		env: {
			ROTOM_API_BASE_URL: "https://rotom.example.com",
		},
	});
	expect(config.webhooks.discordUrls).toEqual([]);
	expect(config.webhooks.events.size).toBe(0);
	expect(config.webhooks.coalesceWindowMs).toBe(10_000);
	expect(config.webhooks.retryAttempts).toBe(3);
	expect(config.webhooks.username).toBe("rotom-watcher");
});

test("parses webhook config from TOML file shape", () => {
	const config = createConfig({
		env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
		fileConfig: {
			webhooks: {
				avatar_url: "https://cdn.example.com/avatar.png",
				coalesce_window_ms: 5000,
				discord: ["https://discord.com/api/webhooks/A/secret"],
				events: ["origin.offline.update", "script.failed"],
				mention_role_id: "1234567890",
				retry_attempts: 5,
				retry_initial_delay_ms: 250,
				username: "rotom",
			},
		},
	});
	expect(config.webhooks.discordUrls).toEqual([
		"https://discord.com/api/webhooks/A/secret",
	]);
	expect(config.webhooks.events.has("origin.offline.update")).toBe(true);
	expect(config.webhooks.events.has("script.failed")).toBe(true);
	expect(config.webhooks.events.size).toBe(2);
	expect(config.webhooks.mentionRoleId).toBe("1234567890");
	expect(config.webhooks.coalesceWindowMs).toBe(5000);
	expect(config.webhooks.retryAttempts).toBe(5);
	expect(config.webhooks.retryInitialDelayMs).toBe(250);
	expect(config.webhooks.username).toBe("rotom");
	expect(config.webhooks.avatarUrl).toBe("https://cdn.example.com/avatar.png");
});

test("splits comma-separated WEBHOOKS_DISCORD env into array", () => {
	const config = createConfig({
		env: {
			ROTOM_API_BASE_URL: "https://rotom.example.com",
			WEBHOOKS_DISCORD:
				"https://discord.com/api/webhooks/A,https://discord.com/api/webhooks/B",
		},
	});
	expect(config.webhooks.discordUrls).toEqual([
		"https://discord.com/api/webhooks/A",
		"https://discord.com/api/webhooks/B",
	]);
});

test("splits comma-separated WEBHOOKS_EVENTS env into Set", () => {
	const config = createConfig({
		env: {
			ROTOM_API_BASE_URL: "https://rotom.example.com",
			WEBHOOKS_EVENTS: "origin.recovered,script.succeeded",
		},
	});
	expect(config.webhooks.events.has("origin.recovered")).toBe(true);
	expect(config.webhooks.events.has("script.succeeded")).toBe(true);
});

test("rejects unknown event name", () => {
	expect(() =>
		createConfig({
			env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
			fileConfig: {
				webhooks: { events: ["origin.exploded"] },
			},
		}),
	).toThrow();
});

test("rejects non-HTTPS Discord URL", () => {
	expect(() =>
		createConfig({
			env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
			fileConfig: {
				webhooks: { discord: ["http://discord.com/api/webhooks/X"] },
			},
		}),
	).toThrow();
});

test("rejects non-snowflake mention_role_id", () => {
	expect(() =>
		createConfig({
			env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
			fileConfig: {
				webhooks: { mention_role_id: "not-a-snowflake" },
			},
		}),
	).toThrow();
});

test("accepts coalesce_window_ms = 0 (disabled)", () => {
	const config = createConfig({
		env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
		fileConfig: {
			webhooks: { coalesce_window_ms: 0 },
		},
	});
	expect(config.webhooks.coalesceWindowMs).toBe(0);
});
```

- [ ] **Step 11: Run tests, typecheck, lint**

```bash
bun test src/config
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add src/config/schema.ts src/config/config.test.ts
git commit -m "feat(config): add webhooks config block with validation"
```

---

## Task 3: WebhookDispatcher core (filtering, no coalescing yet)

**Files:**
- Create: `src/webhooks/dispatcher.ts`
- Test: `src/webhooks/dispatcher.test.ts`

Start with the simplest version: filter events by config, hand them to a transport synchronously. Coalescing comes in Task 4.

- [ ] **Step 1: Write `src/webhooks/dispatcher.test.ts` with the basic filtering tests**

```typescript
import { describe, expect, test } from "bun:test";
import type { LoggerLike } from "../observability/logger";
import { WebhookDispatcher } from "./dispatcher";
import type { WebhookEvent, WebhookTransport } from "./types";

const silentLogger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

const createFakeTransport = () => {
	const batches: WebhookEvent[][] = [];
	const transport: WebhookTransport = {
		send: async (batch) => {
			batches.push(batch);
		},
	};
	return { batches, transport };
};

const baseConfig = {
	coalesceWindowMs: 0,
	discordUrls: ["https://discord.com/api/webhooks/X"],
	events: new Set(["script.failed"] as const),
};

const exampleEvent: WebhookEvent = {
	fields: {
		attempts: 3,
		durationMs: 1000,
		exitCode: 1,
		mode: "restart",
		runId: "r-1",
	},
	name: "script.failed",
	subject: "manila",
};

describe("WebhookDispatcher (filtering)", () => {
	test("forwards events whose name is enabled", async () => {
		const { batches, transport } = createFakeTransport();
		const dispatcher = new WebhookDispatcher({
			config: baseConfig,
			logger: silentLogger,
			transport,
		});
		dispatcher.emit(exampleEvent);
		await dispatcher.flush();
		expect(batches).toHaveLength(1);
		expect(batches[0]).toEqual([exampleEvent]);
	});

	test("drops events when discordUrls is empty", async () => {
		const { batches, transport } = createFakeTransport();
		const dispatcher = new WebhookDispatcher({
			config: { ...baseConfig, discordUrls: [] },
			logger: silentLogger,
			transport,
		});
		dispatcher.emit(exampleEvent);
		await dispatcher.flush();
		expect(batches).toHaveLength(0);
	});

	test("drops events whose name is not enabled", async () => {
		const { batches, transport } = createFakeTransport();
		const dispatcher = new WebhookDispatcher({
			config: { ...baseConfig, events: new Set(["origin.recovered"]) },
			logger: silentLogger,
			transport,
		});
		dispatcher.emit(exampleEvent);
		await dispatcher.flush();
		expect(batches).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/webhooks/dispatcher.test.ts
```

Expected: FAIL — `WebhookDispatcher` not defined.

- [ ] **Step 3: Create `src/webhooks/dispatcher.ts` with the minimum to pass**

```typescript
import type { LoggerLike } from "../observability/logger";
import type { EventName, WebhookEvent, WebhookTransport } from "./types";

export interface DispatcherConfig {
	coalesceWindowMs: number;
	discordUrls: string[];
	events: ReadonlySet<EventName>;
}

export interface WebhookDispatcherDeps {
	config: DispatcherConfig;
	logger: LoggerLike;
	transport: WebhookTransport;
}

export class WebhookDispatcher {
	private readonly config: DispatcherConfig;
	private readonly logger: LoggerLike;
	private readonly transport: WebhookTransport;

	constructor(deps: WebhookDispatcherDeps) {
		this.config = deps.config;
		this.logger = deps.logger;
		this.transport = deps.transport;
	}

	emit(event: WebhookEvent): void {
		if (this.config.discordUrls.length === 0) {
			return;
		}
		if (!this.config.events.has(event.name)) {
			return;
		}
		void this.dispatch([event]);
	}

	async flush(): Promise<void> {
		// No-op for now; coalescing buffer added in the next task.
	}

	private async dispatch(batch: WebhookEvent[]): Promise<void> {
		try {
			await this.transport.send(batch);
		} catch (error) {
			this.logger.error(
				{ error, eventCount: batch.length },
				"Webhook transport send failed",
			);
		}
	}
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/webhooks/dispatcher.test.ts
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/webhooks/dispatcher.ts src/webhooks/dispatcher.test.ts
git commit -m "feat(webhooks): add WebhookDispatcher with filtering"
```

---

## Task 4: Coalescing buffer in dispatcher

**Files:**
- Modify: `src/webhooks/dispatcher.ts`
- Modify: `src/webhooks/dispatcher.test.ts`

Add a same-name coalescing buffer with a configurable window.

- [ ] **Step 1: Add new failing tests to `dispatcher.test.ts`**

Append these tests inside the existing `describe`:

```typescript
test("coalesceWindowMs = 0 dispatches synchronously, never buffers", async () => {
	const { batches, transport } = createFakeTransport();
	const dispatcher = new WebhookDispatcher({
		config: { ...baseConfig, coalesceWindowMs: 0 },
		logger: silentLogger,
		transport,
	});
	dispatcher.emit(exampleEvent);
	dispatcher.emit(exampleEvent);
	await dispatcher.flush();
	expect(batches).toHaveLength(2);
});

test("coalesces multiple same-name events emitted within the window", async () => {
	let now = 0;
	const timers: Array<{ at: number; fn: () => void }> = [];
	const setTimer = (fn: () => void, ms: number) => {
		const id = timers.length;
		timers.push({ at: now + ms, fn });
		return id as unknown as ReturnType<typeof setTimeout>;
	};
	const clearTimer = (id: ReturnType<typeof setTimeout>) => {
		const index = id as unknown as number;
		if (timers[index]) {
			timers[index] = { at: Number.POSITIVE_INFINITY, fn: () => undefined };
		}
	};
	const advance = (ms: number) => {
		now += ms;
		for (const t of timers.splice(0)) {
			if (t.at <= now) t.fn();
			else timers.push(t);
		}
	};

	const { batches, transport } = createFakeTransport();
	const dispatcher = new WebhookDispatcher({
		clock: { clearTimer, now: () => now, setTimer },
		config: {
			coalesceWindowMs: 1000,
			discordUrls: ["https://discord.com/api/webhooks/X"],
			events: new Set(["script.failed"]),
		},
		logger: silentLogger,
		transport,
	});

	const eventA: WebhookEvent = {
		...exampleEvent,
		subject: "manila",
	};
	const eventB: WebhookEvent = {
		...exampleEvent,
		subject: "cebu",
	};
	dispatcher.emit(eventA);
	dispatcher.emit(eventB);

	expect(batches).toHaveLength(0);
	advance(1000);
	await dispatcher.flush();

	expect(batches).toHaveLength(1);
	expect(batches[0]).toHaveLength(2);
	expect(batches[0][0].subject).toBe("manila");
	expect(batches[0][1].subject).toBe("cebu");
});

test("does not coalesce events with different names", async () => {
	let now = 0;
	const timers: Array<{ at: number; fn: () => void }> = [];
	const setTimer = (fn: () => void, ms: number) => {
		const id = timers.length;
		timers.push({ at: now + ms, fn });
		return id as unknown as ReturnType<typeof setTimeout>;
	};
	const clearTimer = (id: ReturnType<typeof setTimeout>) => {
		const index = id as unknown as number;
		if (timers[index]) {
			timers[index] = { at: Number.POSITIVE_INFINITY, fn: () => undefined };
		}
	};
	const advance = (ms: number) => {
		now += ms;
		for (const t of timers.splice(0)) {
			if (t.at <= now) t.fn();
			else timers.push(t);
		}
	};

	const { batches, transport } = createFakeTransport();
	const dispatcher = new WebhookDispatcher({
		clock: { clearTimer, now: () => now, setTimer },
		config: {
			coalesceWindowMs: 1000,
			discordUrls: ["https://discord.com/api/webhooks/X"],
			events: new Set(["script.failed", "origin.recovered"]),
		},
		logger: silentLogger,
		transport,
	});

	dispatcher.emit(exampleEvent);
	dispatcher.emit({
		fields: {
			devices: 4,
			downForMs: 5_000,
			lastScript: "restart",
			result: "success",
		},
		name: "origin.recovered",
		subject: "manila",
	});

	advance(1000);
	await dispatcher.flush();

	expect(batches).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/webhooks/dispatcher.test.ts
```

Expected: new tests fail; the new ones reference an unknown `clock` parameter.

- [ ] **Step 3: Update `dispatcher.ts` to add the coalescing buffer and a clock interface**

Replace the file contents with:

```typescript
import type { LoggerLike } from "../observability/logger";
import type { EventName, WebhookEvent, WebhookTransport } from "./types";

export interface DispatcherConfig {
	coalesceWindowMs: number;
	discordUrls: string[];
	events: ReadonlySet<EventName>;
}

export interface DispatcherClock {
	clearTimer(id: ReturnType<typeof setTimeout>): void;
	now(): number;
	setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
}

const defaultClock: DispatcherClock = {
	clearTimer: (id) => clearTimeout(id),
	now: () => Date.now(),
	setTimer: (fn, ms) => setTimeout(fn, ms),
};

export interface WebhookDispatcherDeps {
	clock?: DispatcherClock;
	config: DispatcherConfig;
	logger: LoggerLike;
	transport: WebhookTransport;
}

interface BufferedBatch {
	events: WebhookEvent[];
	timer: ReturnType<typeof setTimeout>;
}

export class WebhookDispatcher {
	private readonly buffer = new Map<EventName, BufferedBatch>();
	private readonly clock: DispatcherClock;
	private readonly config: DispatcherConfig;
	private readonly logger: LoggerLike;
	private readonly pending = new Set<Promise<void>>();
	private readonly transport: WebhookTransport;

	constructor(deps: WebhookDispatcherDeps) {
		this.clock = deps.clock ?? defaultClock;
		this.config = deps.config;
		this.logger = deps.logger;
		this.transport = deps.transport;
	}

	emit(event: WebhookEvent): void {
		if (this.config.discordUrls.length === 0) {
			return;
		}
		if (!this.config.events.has(event.name)) {
			return;
		}

		if (this.config.coalesceWindowMs <= 0) {
			this.trackDispatch([event]);
			return;
		}

		const existing = this.buffer.get(event.name);
		if (existing) {
			existing.events.push(event);
			return;
		}

		const timer = this.clock.setTimer(() => {
			const batch = this.buffer.get(event.name);
			if (!batch) {
				return;
			}
			this.buffer.delete(event.name);
			this.trackDispatch(batch.events);
		}, this.config.coalesceWindowMs);

		this.buffer.set(event.name, { events: [event], timer });
	}

	async flush(): Promise<void> {
		for (const [name, batch] of this.buffer) {
			this.clock.clearTimer(batch.timer);
			this.buffer.delete(name);
			this.trackDispatch(batch.events);
		}
		await Promise.allSettled([...this.pending]);
	}

	private trackDispatch(batch: WebhookEvent[]): void {
		const promise = (async () => {
			try {
				await this.transport.send(batch);
			} catch (error) {
				this.logger.error(
					{ error, eventCount: batch.length },
					"Webhook transport send failed",
				);
			}
		})();
		this.pending.add(promise);
		promise.finally(() => {
			this.pending.delete(promise);
		});
	}
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

```bash
bun test src/webhooks/dispatcher.test.ts
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/webhooks/dispatcher.ts src/webhooks/dispatcher.test.ts
git commit -m "feat(webhooks): add coalescing buffer to dispatcher"
```

---

## Task 5: DiscordTransport — single-event rendering

**Files:**
- Create: `src/webhooks/discord-transport.ts`
- Test: `src/webhooks/discord-transport.test.ts`

This task implements rendering for all 15 events. POSTing comes in Task 7. Use a fake fetch that does nothing yet.

- [ ] **Step 1: Add a duration formatter to `src/shared/utils.ts`**

Open [src/shared/utils.ts](src/shared/utils.ts). Append:

```typescript
export const formatDuration = (ms: number): string => {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) {
		return `${seconds}s`;
	}
	return `${minutes}m ${seconds}s`;
};
```

- [ ] **Step 2: Add a unit test for `formatDuration` in `src/shared/utils.test.ts`**

Append inside the existing `describe`:

```typescript
test("formatDuration: sub-second values render as ms", () => {
	expect(formatDuration(0)).toBe("0ms");
	expect(formatDuration(999)).toBe("999ms");
});

test("formatDuration: seconds-only values omit the minutes portion", () => {
	expect(formatDuration(1_000)).toBe("1s");
	expect(formatDuration(45_000)).toBe("45s");
});

test("formatDuration: minute+second values include both", () => {
	expect(formatDuration(60_000)).toBe("1m 0s");
	expect(formatDuration(252_000)).toBe("4m 12s");
});
```

Add `formatDuration` to the import line at the top of the test file.

- [ ] **Step 3: Write `src/webhooks/discord-transport.test.ts` (renderer tests only — POST tests later)**

```typescript
import { describe, expect, test } from "bun:test";
import type { LoggerLike } from "../observability/logger";
import { DiscordTransport } from "./discord-transport";
import type { WebhookEvent } from "./types";

const silentLogger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

const baseConfig = {
	avatarUrl: "",
	discordUrls: ["https://discord.com/api/webhooks/A/secret"],
	mentionRoleId: "",
	retryAttempts: 0,
	retryInitialDelayMs: 1,
	username: "rotom-watcher",
};

const captureFetch = () => {
	const calls: { url: string; init: RequestInit }[] = [];
	const fakeFetch: typeof fetch = async (url, init) => {
		calls.push({ init: init as RequestInit, url: url as string });
		return new Response("", { status: 204 });
	};
	return { calls, fakeFetch };
};

const renderSingle = async (event: WebhookEvent) => {
	const { calls, fakeFetch } = captureFetch();
	const transport = new DiscordTransport({
		clock: { now: () => 1_700_000_000_000 },
		config: baseConfig,
		fetchImpl: fakeFetch,
		logger: silentLogger,
		sleepFn: async () => undefined,
	});
	await transport.send([event]);
	expect(calls).toHaveLength(1);
	const body = JSON.parse(calls[0].init.body as string);
	return body;
};

describe("DiscordTransport.render (single events)", () => {
	test("script.failed renders Critical color, title, fields", async () => {
		const body = await renderSingle({
			fields: {
				attempts: 3,
				durationMs: 252_000,
				exitCode: 1,
				mode: "restart",
				runId: "r-8a3f",
			},
			name: "script.failed",
			subject: "quezon-city",
		});
		expect(body.username).toBe("rotom-watcher");
		expect(body.embeds).toHaveLength(1);
		const embed = body.embeds[0];
		expect(embed.color).toBe(0xed4245);
		expect(embed.title).toContain("CRITICAL");
		expect(embed.title).toContain("script.failed");
		expect(embed.title).toContain("quezon-city");
		expect(
			embed.fields.find((f: { name: string }) => f.name === "Mode").value,
		).toBe("`restart`");
		expect(
			embed.fields.find((f: { name: string }) => f.name === "Tries").value,
		).toBe("3");
		expect(
			embed.fields.find((f: { name: string }) => f.name === "Took").value,
		).toBe("4m 12s");
	});

	test("origin.offline.restart renders Warning color", async () => {
		const body = await renderSingle({
			fields: { attempt: 1, devices: 8, lastSeenMs: 660_000, mode: "restart" },
			name: "origin.offline.restart",
			subject: "manila",
		});
		const embed = body.embeds[0];
		expect(embed.color).toBe(0xfaa61a);
		expect(embed.title).toContain("WARNING");
	});

	test("origin.recovered renders Success color", async () => {
		const body = await renderSingle({
			fields: {
				devices: 9,
				downForMs: 381_000,
				lastScript: "restart",
				result: "success",
			},
			name: "origin.recovered",
			subject: "cebu",
		});
		expect(body.embeds[0].color).toBe(0x57f287);
	});

	test("service.started renders Info color and rotom-watcher subject", async () => {
		const body = await renderSingle({
			fields: {
				concurrency: 10,
				origins: 14,
				pid: 11_712,
				pollIntervalMs: 300_000,
				version: "0.1.0",
			},
			name: "service.started",
			subject: "rotom-watcher",
		});
		expect(body.embeds[0].color).toBe(0x5865f2);
		expect(body.embeds[0].title).toContain("rotom-watcher");
	});

	test("circuit_breaker.opened renders subject 'rotom-api'", async () => {
		const body = await renderSingle({
			fields: { failures: 5, resetMs: 60_000, threshold: 5 },
			name: "circuit_breaker.opened",
			subject: "rotom-api",
		});
		expect(body.embeds[0].title).toContain("rotom-api");
	});

	test("renders one embed per call (regression check)", async () => {
		const body = await renderSingle({
			fields: { failures: 5, resetMs: 60_000, threshold: 5 },
			name: "circuit_breaker.opened",
			subject: "rotom-api",
		});
		expect(body.embeds).toHaveLength(1);
	});
});
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
bun test src/webhooks/discord-transport.test.ts
```

Expected: FAIL — `DiscordTransport` not defined.

- [ ] **Step 5: Create `src/webhooks/discord-transport.ts`**

```typescript
import { formatDuration } from "../shared/utils";
import type { LoggerLike } from "../observability/logger";
import { SEVERITY, SEVERITY_COLOR, SEVERITY_LABEL } from "./events";
import type {
	EventName,
	Severity,
	WebhookEvent,
	WebhookEventOf,
	WebhookTransport,
} from "./types";

export interface DiscordTransportConfig {
	avatarUrl: string;
	discordUrls: string[];
	mentionRoleId: string;
	retryAttempts: number;
	retryInitialDelayMs: number;
	username: string;
}

export interface DiscordTransportClock {
	now(): number;
}

export interface DiscordTransportDeps {
	clock?: DiscordTransportClock;
	config: DiscordTransportConfig;
	fetchImpl?: typeof fetch;
	logger: LoggerLike;
	sleepFn?: (ms: number) => Promise<void>;
}

interface DiscordEmbed {
	color: number;
	description?: string;
	fields?: { inline?: boolean; name: string; value: string }[];
	footer?: { text: string };
	title: string;
}

interface DiscordWebhookBody {
	allowed_mentions?: { roles: string[] };
	avatar_url?: string;
	content?: string;
	embeds: DiscordEmbed[];
	username: string;
}

const defaultClock: DiscordTransportClock = { now: () => Date.now() };

const formatTimestamp = (ms: number): string => {
	const date = new Date(ms);
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const min = String(date.getUTCMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
};

type Renderer<N extends EventName> = (
	event: WebhookEventOf<N>,
	timestamp: string,
) => DiscordEmbed;

const titleFor = (severity: Severity, name: EventName, subject: string) =>
	`${SEVERITY_LABEL[severity]} · ${name} | ${subject}`;

const baseEmbed = (event: WebhookEvent, timestamp: string): DiscordEmbed => {
	const severity = SEVERITY[event.name];
	return {
		color: SEVERITY_COLOR[severity],
		footer: { text: `rotom-watcher • ${timestamp}` },
		title: titleFor(severity, event.name, event.subject),
	};
};

const RENDERERS: { [N in EventName]: Renderer<N> } = {
	"circuit_breaker.closed": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: "Rotom API circuit breaker returned to **CLOSED**.",
	}),
	"circuit_breaker.half_open": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description:
			"Rotom API circuit breaker entered **HALF_OPEN** — testing recovery.",
		fields: [
			{
				inline: true,
				name: "Reset window",
				value: formatDuration(event.fields.resetMs),
			},
		],
	}),
	"circuit_breaker.opened": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description:
			"Rotom API failures hit the threshold. Circuit breaker **OPENED**.",
		fields: [
			{
				inline: true,
				name: "Failures",
				value: event.fields.failures.toString(),
			},
			{
				inline: true,
				name: "Threshold",
				value: event.fields.threshold.toString(),
			},
			{
				inline: true,
				name: "Reset",
				value: formatDuration(event.fields.resetMs),
			},
		],
	}),
	"device.duplicate_deleted": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Removed dead duplicate device on **${event.fields.origin}**.`,
		fields: [
			{ inline: true, name: "Device ID", value: `\`${event.fields.deviceId}\`` },
		],
	}),
	"group.pipeline.triggered": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Group recovery pipeline triggered for **${event.subject}**.`,
		fields: [
			{ inline: true, name: "Group size", value: event.fields.groupSize.toString() },
			{ inline: true, name: "Trigger", value: event.fields.trigger },
		],
	}),
	"origin.offline.restart": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Origin **${event.subject}** appears offline. Running \`restart\` script.`,
		fields: [
			{ inline: true, name: "Mode", value: "`restart`" },
			{ inline: true, name: "Attempt", value: event.fields.attempt.toString() },
			{ inline: true, name: "Devices", value: event.fields.devices.toString() },
			{
				inline: true,
				name: "Last seen",
				value: `${formatDuration(event.fields.lastSeenMs)} ago`,
			},
		],
	}),
	"origin.offline.update": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Origin **${event.subject}** escalated to \`update\` mode after repeated restart failures.`,
		fields: [
			{ inline: true, name: "Mode", value: "`update`" },
			{
				inline: true,
				name: "Offline streak",
				value: event.fields.offlineStreak.toString(),
			},
			{ inline: true, name: "Devices", value: event.fields.devices.toString() },
			{
				inline: true,
				name: "Last seen",
				value: `${formatDuration(event.fields.lastSeenMs)} ago`,
			},
		],
	}),
	"origin.recovered": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Origin **${event.subject}** is back online.`,
		fields: [
			{
				inline: true,
				name: "Down for",
				value: formatDuration(event.fields.downForMs),
			},
			{
				inline: true,
				name: "Last script",
				value: `\`${event.fields.lastScript}\``,
			},
			{ inline: true, name: "Result", value: event.fields.result },
			{ inline: true, name: "Devices", value: event.fields.devices.toString() },
		],
	}),
	"poll.failed": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: "Rotom API poll failed.",
		fields: [
			{ name: "Reason", value: event.fields.reason },
			{
				inline: true,
				name: "Took",
				value: formatDuration(event.fields.durationMs),
			},
		],
	}),
	"queue.saturated": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: "Job queue saturated; new jobs being rejected.",
		fields: [
			{ inline: true, name: "Capacity", value: event.fields.capacity.toString() },
			{ inline: true, name: "Running", value: event.fields.running.toString() },
			{ inline: true, name: "Queued", value: event.fields.queued.toString() },
			{ inline: true, name: "Rejected", value: event.fields.rejected.toString() },
		],
	}),
	"script.failed": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Origin **${event.subject}** could not be recovered after retries.`,
		fields: [
			{ inline: true, name: "Mode", value: `\`${event.fields.mode}\`` },
			{
				inline: true,
				name: "Exit",
				value: event.fields.exitCode === null ? "—" : event.fields.exitCode.toString(),
			},
			{ inline: true, name: "Tries", value: event.fields.attempts.toString() },
			{
				inline: true,
				name: "Took",
				value: formatDuration(event.fields.durationMs),
			},
		],
		footer: { text: `run ${event.fields.runId} • ${timestamp}` },
	}),
	"script.succeeded": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Recovery script for **${event.subject}** completed successfully.`,
		fields: [
			{ inline: true, name: "Mode", value: `\`${event.fields.mode}\`` },
			{ inline: true, name: "Attempt", value: event.fields.attempt.toString() },
			{
				inline: true,
				name: "Took",
				value: formatDuration(event.fields.durationMs),
			},
		],
		footer: { text: `run ${event.fields.runId} • ${timestamp}` },
	}),
	"script.timed_out": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Recovery script on **${event.subject}** was killed for exceeding its timeout.`,
		fields: [
			{ inline: true, name: "Mode", value: `\`${event.fields.mode}\`` },
			{ inline: true, name: "Attempt", value: event.fields.attempt.toString() },
			{
				inline: true,
				name: "Timeout",
				value: formatDuration(event.fields.timeoutMs),
			},
		],
		footer: { text: `run ${event.fields.runId} • ${timestamp}` },
	}),
	"service.started": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `rotom-watcher v${event.fields.version} started.`,
		fields: [
			{ inline: true, name: "Origins", value: event.fields.origins.toString() },
			{
				inline: true,
				name: "Poll interval",
				value: formatDuration(event.fields.pollIntervalMs),
			},
			{
				inline: true,
				name: "Concurrency",
				value: event.fields.concurrency.toString(),
			},
			{ inline: true, name: "PID", value: event.fields.pid.toString() },
		],
	}),
	"service.stopping": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `rotom-watcher shutting down (${event.fields.reason}).`,
		fields: [
			{
				inline: true,
				name: "Running jobs",
				value: event.fields.runningJobs.toString(),
			},
			{
				inline: true,
				name: "Queued jobs",
				value: event.fields.queuedJobs.toString(),
			},
		],
	}),
};

const renderEmbed = (event: WebhookEvent, timestamp: string): DiscordEmbed => {
	const renderer = RENDERERS[event.name] as Renderer<EventName>;
	return renderer(event as never, timestamp);
};

export class DiscordTransport implements WebhookTransport {
	private readonly clock: DiscordTransportClock;
	private readonly config: DiscordTransportConfig;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: LoggerLike;
	private readonly sleepFn: (ms: number) => Promise<void>;

	constructor(deps: DiscordTransportDeps) {
		this.clock = deps.clock ?? defaultClock;
		this.config = deps.config;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.logger = deps.logger;
		this.sleepFn =
			deps.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async send(batch: WebhookEvent[]): Promise<void> {
		if (batch.length === 0 || this.config.discordUrls.length === 0) {
			return;
		}

		const timestamp = formatTimestamp(this.clock.now());
		const embed = renderEmbed(batch[0], timestamp);
		const body: DiscordWebhookBody = {
			embeds: [embed],
			username: this.config.username,
		};
		if (this.config.avatarUrl !== "") {
			body.avatar_url = this.config.avatarUrl;
		}

		await Promise.all(
			this.config.discordUrls.map((url) => this.postOnce(url, body)),
		);
	}

	private async postOnce(url: string, body: DiscordWebhookBody): Promise<void> {
		await this.fetchImpl(url, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
	}
}
```

- [ ] **Step 6: Run tests, typecheck, lint**

```bash
bun test src/webhooks/discord-transport.test.ts src/shared/utils.test.ts
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/webhooks/discord-transport.ts src/webhooks/discord-transport.test.ts src/shared/utils.ts src/shared/utils.test.ts
git commit -m "feat(webhooks): add DiscordTransport with single-event rendering"
```

---

## Task 6: DiscordTransport — coalesced batch rendering

**Files:**
- Modify: `src/webhooks/discord-transport.ts`
- Modify: `src/webhooks/discord-transport.test.ts`

A batch of N≥2 same-name events renders as one summary embed listing the unique subjects.

- [ ] **Step 1: Add tests for coalesced rendering**

Append inside the existing `describe("DiscordTransport.render (single events)", ...)` or create a new `describe`:

```typescript
describe("DiscordTransport.render (coalesced batches)", () => {
	test("renders a single coalesced embed with subject list", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 1_700_000_000_000 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		const event = (subject: string): WebhookEvent => ({
			fields: {
				devices: 4,
				lastSeenMs: 600_000,
				mode: "update",
				offlineStreak: 3,
			},
			name: "origin.offline.update",
			subject,
		});
		await transport.send([event("manila"), event("cebu"), event("davao")]);
		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0].init.body as string);
		expect(body.embeds).toHaveLength(1);
		const embed = body.embeds[0];
		expect(embed.title).toContain("(×3)");
		expect(embed.title).toContain("multiple subjects");
		const subjectsField = embed.fields.find(
			(f: { name: string }) => f.name === "Subjects",
		);
		expect(subjectsField.value).toContain("manila");
		expect(subjectsField.value).toContain("cebu");
		expect(subjectsField.value).toContain("davao");
	});

	test("truncates subject list past 20 entries with '+ N more'", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 1_700_000_000_000 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		const events: WebhookEvent[] = Array.from({ length: 25 }, (_, i) => ({
			fields: {
				devices: 1,
				lastSeenMs: 60_000,
				mode: "update",
				offlineStreak: 1,
			},
			name: "origin.offline.update",
			subject: `origin-${i.toString().padStart(2, "0")}`,
		}));
		await transport.send(events);
		const body = JSON.parse(calls[0].init.body as string);
		const subjectsField = body.embeds[0].fields.find(
			(f: { name: string }) => f.name === "Subjects",
		);
		expect(subjectsField.value).toContain("+ 5 more");
		expect(subjectsField.value).toContain("origin-19");
		expect(subjectsField.value).not.toContain("origin-20");
	});

	test("deduplicates repeated subjects in coalesced batch", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 1_700_000_000_000 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		const event = (subject: string): WebhookEvent => ({
			fields: {
				devices: 1,
				lastSeenMs: 60_000,
				mode: "update",
				offlineStreak: 1,
			},
			name: "origin.offline.update",
			subject,
		});
		await transport.send([event("manila"), event("manila"), event("cebu")]);
		const body = JSON.parse(calls[0].init.body as string);
		expect(body.embeds[0].title).toContain("(×3)");
		const subjectsField = body.embeds[0].fields.find(
			(f: { name: string }) => f.name === "Subjects",
		);
		expect(subjectsField.value.match(/manila/g)).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/webhooks/discord-transport.test.ts
```

Expected: new tests fail; transport currently only renders the first event.

- [ ] **Step 3: Replace `send` and add a coalesced renderer in `discord-transport.ts`**

Replace the `send` method on `DiscordTransport`:

```typescript
async send(batch: WebhookEvent[]): Promise<void> {
	if (batch.length === 0 || this.config.discordUrls.length === 0) {
		return;
	}

	const timestamp = formatTimestamp(this.clock.now());
	const embed =
		batch.length === 1
			? renderEmbed(batch[0], timestamp)
			: renderCoalesced(batch, timestamp);
	const body: DiscordWebhookBody = {
		embeds: [embed],
		username: this.config.username,
	};
	if (this.config.avatarUrl !== "") {
		body.avatar_url = this.config.avatarUrl;
	}

	await Promise.all(
		this.config.discordUrls.map((url) => this.postOnce(url, body)),
	);
}
```

Add this helper near `renderEmbed`:

```typescript
const SUBJECT_LIMIT = 20;

const renderCoalesced = (
	batch: WebhookEvent[],
	timestamp: string,
): DiscordEmbed => {
	const name = batch[0].name;
	const severity = SEVERITY[name];
	const uniqueSubjects = Array.from(new Set(batch.map((event) => event.subject)));
	const shown = uniqueSubjects.slice(0, SUBJECT_LIMIT);
	const remaining = uniqueSubjects.length - shown.length;
	const subjectsValue =
		remaining > 0 ? `${shown.join(", ")}, + ${remaining} more` : shown.join(", ");

	return {
		color: SEVERITY_COLOR[severity],
		description: summaryFor(name, batch.length),
		fields: [{ name: "Subjects", value: subjectsValue }],
		footer: { text: `coalesced batch • ${timestamp}` },
		title: `${SEVERITY_LABEL[severity]} · ${name} (×${batch.length}) | multiple subjects`,
	};
};

const summaryFor = (name: EventName, count: number): string => {
	switch (name) {
		case "origin.offline.restart":
			return `${count} origins entered offline state.`;
		case "origin.offline.update":
			return `${count} origins escalated to update mode.`;
		case "origin.recovered":
			return `${count} origins recovered.`;
		case "script.failed":
			return `${count} recovery scripts failed.`;
		case "script.succeeded":
			return `${count} recovery scripts succeeded.`;
		case "script.timed_out":
			return `${count} recovery scripts timed out.`;
		case "poll.failed":
			return `${count} polls failed.`;
		case "device.duplicate_deleted":
			return `${count} dead duplicates removed.`;
		case "group.pipeline.triggered":
			return `${count} group pipelines triggered.`;
		default:
			return `${count} events received.`;
	}
};
```

- [ ] **Step 4: Run tests, typecheck, lint**

```bash
bun test src/webhooks/discord-transport.test.ts
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/webhooks/discord-transport.ts src/webhooks/discord-transport.test.ts
git commit -m "feat(webhooks): add coalesced batch rendering"
```

---

## Task 7: DiscordTransport — POST with retry policy

**Files:**
- Modify: `src/webhooks/discord-transport.ts`
- Modify: `src/webhooks/discord-transport.test.ts`

Add retry logic for 5xx, 429, network errors, and timeouts. 4xx (non-429) drops without retry.

- [ ] **Step 1: Add tests for retry behavior**

Append inside the test file:

```typescript
describe("DiscordTransport.send (retry)", () => {
	test("retries on 5xx up to retryAttempts then gives up", async () => {
		let calls = 0;
		const fakeFetch: typeof fetch = async () => {
			calls += 1;
			return new Response("oops", { status: 503 });
		};
		const sleeps: number[] = [];
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 2, retryInitialDelayMs: 10 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(3);
		expect(sleeps).toEqual([10, 20]);
	});

	test("4xx (non-429) does not retry", async () => {
		let calls = 0;
		const fakeFetch: typeof fetch = async () => {
			calls += 1;
			return new Response("bad", { status: 400 });
		};
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 5, retryInitialDelayMs: 10 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(1);
	});

	test("429 with Retry-After header honors header instead of backoff", async () => {
		let calls = 0;
		const responses = [
			new Response("rate limited", {
				headers: { "retry-after": "0.5" },
				status: 429,
			}),
			new Response("", { status: 204 }),
		];
		const fakeFetch: typeof fetch = async () => {
			const response = responses[calls];
			calls += 1;
			return response;
		};
		const sleeps: number[] = [];
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 3, retryInitialDelayMs: 10 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(2);
		expect(sleeps).toEqual([500]);
	});

	test("network error retries", async () => {
		let calls = 0;
		const fakeFetch: typeof fetch = async () => {
			calls += 1;
			if (calls < 3) {
				throw new Error("network down");
			}
			return new Response("", { status: 204 });
		};
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 3, retryInitialDelayMs: 5 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(3);
	});

	test("posts to all discordUrls in parallel", async () => {
		const inFlight: Set<string> = new Set();
		const seenInFlight: number[] = [];
		const fakeFetch: typeof fetch = async (url) => {
			inFlight.add(url as string);
			seenInFlight.push(inFlight.size);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight.delete(url as string);
			return new Response("", { status: 204 });
		};
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: {
				...baseConfig,
				discordUrls: [
					"https://discord.com/api/webhooks/A",
					"https://discord.com/api/webhooks/B",
				],
			},
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(Math.max(...seenInFlight)).toBe(2);
	});
});
```

- [ ] **Step 2: Replace `postOnce` in `discord-transport.ts` with a retry-capable version**

Replace the `postOnce` method:

```typescript
private async postWithRetry(
	url: string,
	body: DiscordWebhookBody,
): Promise<void> {
	let attempt = 0;
	while (true) {
		const result = await this.tryPost(url, body);
		if (result.ok) {
			return;
		}
		if (!result.retryable) {
			this.logger.warn(
				{ reason: result.reason, status: result.status, url },
				"Dropping webhook (non-retryable)",
			);
			return;
		}
		if (attempt >= this.config.retryAttempts) {
			this.logger.error(
				{ reason: result.reason, status: result.status, url },
				"Dropping webhook after exhausting retries",
			);
			return;
		}
		const delay =
			result.retryAfterMs ??
			this.config.retryInitialDelayMs * 2 ** attempt;
		await this.sleepFn(delay);
		attempt += 1;
	}
}

private async tryPost(
	url: string,
	body: DiscordWebhookBody,
): Promise<
	| { ok: true }
	| {
			ok: false;
			reason: string;
			retryable: boolean;
			retryAfterMs?: number;
			status?: number;
	  }
> {
	try {
		const response = await this.fetchImpl(url, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		if (response.ok) {
			return { ok: true };
		}
		if (response.status === 429) {
			const retryAfter = response.headers.get("retry-after");
			const retryAfterMs =
				retryAfter !== null ? Math.round(Number(retryAfter) * 1000) : undefined;
			return {
				ok: false,
				reason: "429",
				retryable: true,
				retryAfterMs,
				status: 429,
			};
		}
		if (response.status >= 500) {
			return { ok: false, reason: "5xx", retryable: true, status: response.status };
		}
		return { ok: false, reason: "4xx", retryable: false, status: response.status };
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown";
		return { ok: false, reason: `network: ${message}`, retryable: true };
	}
}
```

Update the caller in `send`:

```typescript
await Promise.all(
	this.config.discordUrls.map((url) => this.postWithRetry(url, body)),
);
```

Remove the old `postOnce` method.

- [ ] **Step 3: Run tests, typecheck, lint**

```bash
bun test src/webhooks/discord-transport.test.ts
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/webhooks/discord-transport.ts src/webhooks/discord-transport.test.ts
git commit -m "feat(webhooks): add retry policy to DiscordTransport"
```

---

## Task 8: DiscordTransport — mentions and identity

**Files:**
- Modify: `src/webhooks/discord-transport.ts`
- Modify: `src/webhooks/discord-transport.test.ts`

Add `content`/`allowed_mentions` for Critical events and propagate `avatar_url` when set.

- [ ] **Step 1: Add tests for mentions and identity**

Append to the test file:

```typescript
describe("DiscordTransport.send (identity & mentions)", () => {
	test("includes content + allowed_mentions for critical events when mentionRoleId set", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, mentionRoleId: "1234567890" },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 3,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "manila",
			},
		]);
		const body = JSON.parse(calls[0].init.body as string);
		expect(body.content).toBe("<@&1234567890>");
		expect(body.allowed_mentions).toEqual({ roles: ["1234567890"] });
	});

	test("does not mention on non-critical events even with mentionRoleId set", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, mentionRoleId: "1234567890" },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					devices: 4,
					downForMs: 100,
					lastScript: "restart",
					result: "success",
				},
				name: "origin.recovered",
				subject: "cebu",
			},
		]);
		const body = JSON.parse(calls[0].init.body as string);
		expect(body.content).toBeUndefined();
		expect(body.allowed_mentions).toBeUndefined();
	});

	test("omits avatar_url when empty, includes when set", async () => {
		const { calls: emptyCalls, fakeFetch: emptyFetch } = captureFetch();
		const emptyTransport = new DiscordTransport({
			clock: { now: () => 0 },
			config: baseConfig,
			fetchImpl: emptyFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await emptyTransport.send([
			{
				fields: { failures: 5, resetMs: 60_000, threshold: 5 },
				name: "circuit_breaker.opened",
				subject: "rotom-api",
			},
		]);
		const emptyBody = JSON.parse(emptyCalls[0].init.body as string);
		expect(emptyBody.avatar_url).toBeUndefined();

		const { calls: setCalls, fakeFetch: setFetch } = captureFetch();
		const setTransport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, avatarUrl: "https://cdn.example/x.png" },
			fetchImpl: setFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await setTransport.send([
			{
				fields: { failures: 5, resetMs: 60_000, threshold: 5 },
				name: "circuit_breaker.opened",
				subject: "rotom-api",
			},
		]);
		const setBody = JSON.parse(setCalls[0].init.body as string);
		expect(setBody.avatar_url).toBe("https://cdn.example/x.png");
	});
});
```

- [ ] **Step 2: Update `send` in `discord-transport.ts` to add mention logic**

Modify the `send` method body to inject `content` + `allowed_mentions` when appropriate. Replace the body-construction section with:

```typescript
const timestamp = formatTimestamp(this.clock.now());
const embed =
	batch.length === 1
		? renderEmbed(batch[0], timestamp)
		: renderCoalesced(batch, timestamp);
const body: DiscordWebhookBody = {
	embeds: [embed],
	username: this.config.username,
};
if (this.config.avatarUrl !== "") {
	body.avatar_url = this.config.avatarUrl;
}

const severity = SEVERITY[batch[0].name];
if (severity === "critical" && this.config.mentionRoleId !== "") {
	body.content = `<@&${this.config.mentionRoleId}>`;
	body.allowed_mentions = { roles: [this.config.mentionRoleId] };
}

await Promise.all(
	this.config.discordUrls.map((url) => this.postWithRetry(url, body)),
);
```

- [ ] **Step 3: Run tests, typecheck, lint**

```bash
bun test src/webhooks/discord-transport.test.ts
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/webhooks/discord-transport.ts src/webhooks/discord-transport.test.ts
git commit -m "feat(webhooks): add critical-event mentions and avatar override"
```

---

## Task 9: Webhook metrics

**Files:**
- Modify: `src/observability/metrics.ts`
- Modify: `src/observability/metrics.test.ts`
- Modify: `src/webhooks/discord-transport.ts` (call into metrics)
- Modify: `src/webhooks/dispatcher.ts` (call into metrics)
- Modify: `src/webhooks/discord-transport.test.ts` (assert metric calls)
- Modify: `src/webhooks/dispatcher.test.ts` (assert coalesced increments)

Three new counters: `webhook_events_delivered_total`, `webhook_events_failed_total`, `webhook_events_coalesced_total`.

- [ ] **Step 1: Add the three counters in `metrics.ts`**

Inside the `Metrics` class, add (alphabetical placement among other private fields):

```typescript
private readonly webhookCoalesced = new Counter({
	help: "Webhook events merged into a coalesced batch (events past the first per batch)",
	labelNames: ["event"] as const,
	name: "rotom_watcher_webhook_events_coalesced_total",
	registers: [this.registry],
});

private readonly webhookDelivered = new Counter({
	help: "Webhook batches successfully delivered, by event name and severity",
	labelNames: ["event", "severity"] as const,
	name: "rotom_watcher_webhook_events_delivered_total",
	registers: [this.registry],
});

private readonly webhookFailed = new Counter({
	help: "Webhook delivery failures, by event name and reason",
	labelNames: ["event", "reason"] as const,
	name: "rotom_watcher_webhook_events_failed_total",
	registers: [this.registry],
});
```

Add three public methods inside the class:

```typescript
recordWebhookCoalesced(event: string, count: number): void {
	this.webhookCoalesced.inc({ event }, count);
}

recordWebhookDelivered(event: string, severity: string): void {
	this.webhookDelivered.inc({ event, severity });
}

recordWebhookFailed(event: string, reason: string): void {
	this.webhookFailed.inc({ event, reason });
}
```

- [ ] **Step 2: Add a metrics test**

Open [src/observability/metrics.test.ts](src/observability/metrics.test.ts) and append:

```typescript
test("webhook metrics render through the registry", async () => {
	const metrics = new Metrics();
	metrics.recordWebhookDelivered("script.failed", "critical");
	metrics.recordWebhookFailed("script.failed", "5xx");
	metrics.recordWebhookCoalesced("origin.offline.update", 3);
	const output = await metrics.render();
	expect(output).toContain(
		'rotom_watcher_webhook_events_delivered_total{event="script.failed",severity="critical"} 1',
	);
	expect(output).toContain(
		'rotom_watcher_webhook_events_failed_total{event="script.failed",reason="5xx"} 1',
	);
	expect(output).toContain(
		'rotom_watcher_webhook_events_coalesced_total{event="origin.offline.update"} 3',
	);
});
```

- [ ] **Step 3: Update `discord-transport.ts` to accept a metrics dep and call the counters**

Add to `DiscordTransportDeps`:

```typescript
metrics?: WebhookMetrics;
```

Add a `WebhookMetrics` interface near the top of the file:

```typescript
export interface WebhookMetrics {
	recordWebhookDelivered(event: string, severity: string): void;
	recordWebhookFailed(event: string, reason: string): void;
}
```

Add a `metrics` field to the class and wire it through the constructor with a no-op default:

```typescript
private readonly metrics: WebhookMetrics;

// in constructor:
this.metrics = deps.metrics ?? {
	recordWebhookDelivered: () => undefined,
	recordWebhookFailed: () => undefined,
};
```

Update `postWithRetry` to call `recordWebhookDelivered` after `result.ok` and `recordWebhookFailed(event.name, reason)` on the drop paths. The `event.name` for the call needs to be the batch's event name; pass it into `postWithRetry` via signature change:

```typescript
private async postWithRetry(
	url: string,
	body: DiscordWebhookBody,
	eventName: string,
	severity: string,
): Promise<void> {
	let attempt = 0;
	while (true) {
		const result = await this.tryPost(url, body);
		if (result.ok) {
			this.metrics.recordWebhookDelivered(eventName, severity);
			return;
		}
		if (!result.retryable) {
			this.metrics.recordWebhookFailed(eventName, result.reason);
			this.logger.warn(
				{ reason: result.reason, status: result.status, url },
				"Dropping webhook (non-retryable)",
			);
			return;
		}
		if (attempt >= this.config.retryAttempts) {
			this.metrics.recordWebhookFailed(eventName, `${result.reason}_exhausted`);
			this.logger.error(
				{ reason: result.reason, status: result.status, url },
				"Dropping webhook after exhausting retries",
			);
			return;
		}
		const delay =
			result.retryAfterMs ??
			this.config.retryInitialDelayMs * 2 ** attempt;
		await this.sleepFn(delay);
		attempt += 1;
	}
}
```

Update the call site in `send`:

```typescript
const eventName = batch[0].name;
const severity = SEVERITY[batch[0].name];
// ... existing body assembly ...
await Promise.all(
	this.config.discordUrls.map((url) =>
		this.postWithRetry(url, body, eventName, severity),
	),
);
```

- [ ] **Step 4: Update `dispatcher.ts` to record coalesced counts**

Add to `WebhookDispatcherDeps`:

```typescript
metrics?: DispatcherMetrics;
```

And to the file:

```typescript
export interface DispatcherMetrics {
	recordWebhookCoalesced(event: string, count: number): void;
}
```

Add the field with no-op default and use it in the timer callback when flushing a batch:

```typescript
private readonly metrics: DispatcherMetrics;

// in constructor:
this.metrics = deps.metrics ?? {
	recordWebhookCoalesced: () => undefined,
};
```

Update both flush sites (timer callback and `flush()`) so that for batches with `events.length > 1` we increment by `events.length - 1`:

```typescript
private trackDispatch(batch: WebhookEvent[]): void {
	if (batch.length > 1) {
		this.metrics.recordWebhookCoalesced(batch[0].name, batch.length - 1);
	}
	const promise = (async () => {
		try {
			await this.transport.send(batch);
		} catch (error) {
			this.logger.error(
				{ error, eventCount: batch.length },
				"Webhook transport send failed",
			);
		}
	})();
	this.pending.add(promise);
	promise.finally(() => {
		this.pending.delete(promise);
	});
}
```

- [ ] **Step 5: Add metrics-call assertions to existing tests**

In `discord-transport.test.ts`, add a new `describe` block:

```typescript
describe("DiscordTransport metrics", () => {
	test("records delivered on success", async () => {
		const calls: { method: string; args: unknown[] }[] = [];
		const metrics = {
			recordWebhookDelivered: (...args: unknown[]) =>
				calls.push({ args, method: "delivered" }),
			recordWebhookFailed: (...args: unknown[]) =>
				calls.push({ args, method: "failed" }),
		};
		const fakeFetch: typeof fetch = async () => new Response("", { status: 204 });
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			metrics,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toEqual([
			{ args: ["script.failed", "critical"], method: "delivered" },
		]);
	});

	test("records failed with reason on 4xx", async () => {
		const calls: { method: string; args: unknown[] }[] = [];
		const metrics = {
			recordWebhookDelivered: (...args: unknown[]) =>
				calls.push({ args, method: "delivered" }),
			recordWebhookFailed: (...args: unknown[]) =>
				calls.push({ args, method: "failed" }),
		};
		const fakeFetch: typeof fetch = async () => new Response("bad", { status: 400 });
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			metrics,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls.find((c) => c.method === "failed")?.args).toEqual([
			"script.failed",
			"4xx",
		]);
	});
});
```

In `dispatcher.test.ts`, add this test:

```typescript
test("records coalesced count = batch size - 1", async () => {
	let now = 0;
	const timers: Array<{ at: number; fn: () => void }> = [];
	const setTimer = (fn: () => void, ms: number) => {
		const id = timers.length;
		timers.push({ at: now + ms, fn });
		return id as unknown as ReturnType<typeof setTimeout>;
	};
	const advance = (ms: number) => {
		now += ms;
		for (const t of timers.splice(0)) {
			if (t.at <= now) t.fn();
			else timers.push(t);
		}
	};

	const coalescedCalls: Array<[string, number]> = [];
	const { transport } = createFakeTransport();
	const dispatcher = new WebhookDispatcher({
		clock: { clearTimer: () => undefined, now: () => now, setTimer },
		config: {
			coalesceWindowMs: 1000,
			discordUrls: ["https://discord.com/api/webhooks/X"],
			events: new Set(["script.failed"]),
		},
		logger: silentLogger,
		metrics: {
			recordWebhookCoalesced: (event, count) =>
				coalescedCalls.push([event, count]),
		},
		transport,
	});

	dispatcher.emit(exampleEvent);
	dispatcher.emit(exampleEvent);
	dispatcher.emit(exampleEvent);
	advance(1000);
	await dispatcher.flush();

	expect(coalescedCalls).toEqual([["script.failed", 2]]);
});
```

- [ ] **Step 6: Run tests, typecheck, lint**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/observability/metrics.ts src/observability/metrics.test.ts src/webhooks/discord-transport.ts src/webhooks/dispatcher.ts src/webhooks/discord-transport.test.ts src/webhooks/dispatcher.test.ts
git commit -m "feat(webhooks): add metrics for delivered, failed, coalesced events"
```

---

## Task 10: Wire dispatcher into `index.ts` + emit `service.started` / `service.stopping`

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json` (read version)
- Optional: add an integration test in `src/webhooks/dispatcher.integration.test.ts`

This task instantiates the dispatcher, threads it into existing components (read-only — they don't yet emit), and emits the two service-lifecycle events.

- [ ] **Step 1: Read `package.json` to confirm the `version` field**

```bash
cat package.json | grep version
```

Note: the example does not have a `version` field. Add `"version": "0.1.0"` to `package.json`. (The dispatch payload will read this.)

- [ ] **Step 2: Modify `package.json`**

Add `"version": "0.1.0"` after `"name"`:

```json
{
	"name": "rotom-watcher",
	"version": "0.1.0",
	"module": "index.ts",
	...
}
```

- [ ] **Step 3: Update `src/index.ts` to construct the dispatcher and emit service lifecycle events**

Add imports:

```typescript
import packageJson from "../package.json";
import { WebhookDispatcher } from "./webhooks/dispatcher";
import { DiscordTransport } from "./webhooks/discord-transport";
```

After `metrics` is constructed and `initialConfig` is in scope, insert:

```typescript
const discordTransport = new DiscordTransport({
	config: initialConfig.webhooks,
	logger,
	metrics,
});
const webhookDispatcher = new WebhookDispatcher({
	config: initialConfig.webhooks,
	logger,
	metrics,
	transport: discordTransport,
});
```

After `monitor.start()`, emit `service.started`:

```typescript
webhookDispatcher.emit({
	fields: {
		concurrency: initialConfig.maxConcurrentJobs,
		origins: 0,
		pid: process.pid,
		pollIntervalMs: initialConfig.checkIntervalMs,
		version: packageJson.version,
	},
	name: "service.started",
	subject: "rotom-watcher",
});
```

(The `origins` field starts at 0; downstream emit-site tasks will plumb a real origin count later if desired. For now, 0 is acceptable since the value reflects "origins known at startup time," which is genuinely zero.)

For `service.stopping`, modify the existing `onShutdown` (passed to `DeviceMonitor`) so it emits before tearing things down. Replace the existing:

```typescript
onShutdown: async () => {
	configManager.close();
	observabilityServer.stop();
},
```

with:

```typescript
onShutdown: async (reason: string) => {
	const queueStatus = jobQueue.getStatus();
	webhookDispatcher.emit({
		fields: {
			queuedJobs: queueStatus.queued,
			reason,
			runningJobs: queueStatus.running,
		},
		name: "service.stopping",
		subject: "rotom-watcher",
	});
	await webhookDispatcher.flush();
	configManager.close();
	observabilityServer.stop();
},
```

If `DeviceMonitor`'s `onShutdown` does not currently accept a reason argument, leave the original signature alone and pass a hardcoded `"shutdown"` string instead — verify by reading [src/monitor/device-monitor.ts](src/monitor/device-monitor.ts) and adjust accordingly.

- [ ] **Step 4: Verify `tsconfig.json` has `resolveJsonModule: true`**

```bash
grep resolveJsonModule tsconfig.json
```

If missing, add `"resolveJsonModule": true` to `compilerOptions`.

- [ ] **Step 5: Update `WebhookDispatcherDeps` and `DiscordTransportDeps` to accept the broader Config block**

The dispatcher and transport currently expect narrow shapes (`DispatcherConfig`, `DiscordTransportConfig`). The full `config.webhooks` from `Config` has all fields plus extras the dispatcher doesn't read. TypeScript structural typing handles the extra fields (`coalesceWindowMs`, etc. are in dispatcher; `avatarUrl` etc. in transport). Confirm by running:

```bash
bun run typecheck
```

If errors appear, narrow at the call site (e.g., destructure to the expected shape).

- [ ] **Step 6: Run tests, typecheck, lint**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 7: Manual smoke test**

Start the service against the example config (after copying it):

```bash
cp config.toml.example config.toml
ROTOM_API_BASE_URL=https://example.invalid bun run src/index.ts &
SERVICE_PID=$!
sleep 2
kill $SERVICE_PID
```

Expected: clean startup and shutdown logs. No webhook POST is made because `webhooks.events` is empty.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts package.json tsconfig.json
git commit -m "feat(webhooks): wire dispatcher and emit service lifecycle events"
```

---

## Task 11: Emit circuit-breaker events

**Files:**
- Modify: `src/runtime/circuit-breaker.ts`
- Modify: `src/runtime/circuit-breaker.test.ts`
- Modify: `src/index.ts` (pass dispatcher in)

- [ ] **Step 1: Add a fake-dispatcher test asserting events are emitted**

Open [src/runtime/circuit-breaker.test.ts](src/runtime/circuit-breaker.test.ts) and add at the top:

```typescript
import type { WebhookEvent } from "../webhooks/types";

interface FakeDispatcher {
	emitted: WebhookEvent[];
	emit(event: WebhookEvent): void;
}

const createFakeDispatcher = (): FakeDispatcher => {
	const emitted: WebhookEvent[] = [];
	return {
		emit: (event) => {
			emitted.push(event);
		},
		emitted,
	};
};
```

Append a new test inside the `describe`:

```typescript
test("emits circuit_breaker.opened/half_open/closed events", () => {
	let now = 0;
	const dispatcher = createFakeDispatcher();
	const breaker = new CircuitBreaker(2, 500, logger, () => now, dispatcher);

	breaker.recordFailure();
	breaker.recordFailure();
	expect(
		dispatcher.emitted.find((e) => e.name === "circuit_breaker.opened"),
	).toBeDefined();

	now = 600;
	breaker.canExecute();
	expect(
		dispatcher.emitted.find((e) => e.name === "circuit_breaker.half_open"),
	).toBeDefined();

	breaker.recordSuccess();
	expect(
		dispatcher.emitted.find((e) => e.name === "circuit_breaker.closed"),
	).toBeDefined();
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
bun test src/runtime/circuit-breaker.test.ts
```

Expected: FAIL — dispatcher constructor arg not yet supported.

- [ ] **Step 3: Update `CircuitBreaker` to accept and emit on a dispatcher**

In [src/runtime/circuit-breaker.ts](src/runtime/circuit-breaker.ts), add an optional dispatcher arg:

```typescript
import type { WebhookEmitter } from "../webhooks/types";
```

Modify the constructor:

```typescript
constructor(
	threshold: number,
	resetTimeMs: number,
	private readonly logger: LoggerLike,
	private readonly now: () => number = Date.now,
	private readonly dispatcher?: WebhookEmitter,
) {
	this.threshold = threshold;
	this.resetTimeMs = resetTimeMs;
	this.nextAttempt = this.now();
}
```

Inside `canExecute()`, after the `HALF_OPEN` log line, add:

```typescript
this.dispatcher?.emit({
	fields: { resetMs: this.resetTimeMs },
	name: "circuit_breaker.half_open",
	subject: "rotom-api",
});
```

Inside `recordFailure()`, after the breaker opens log, add:

```typescript
this.dispatcher?.emit({
	fields: {
		failures: this.failures,
		resetMs: this.resetTimeMs,
		threshold: this.threshold,
	},
	name: "circuit_breaker.opened",
	subject: "rotom-api",
});
```

Inside `recordSuccess()`, in the branch where `recoveredFrom !== "CLOSED"`, add:

```typescript
this.dispatcher?.emit({
	fields: {},
	name: "circuit_breaker.closed",
	subject: "rotom-api",
});
```

- [ ] **Step 4: Wire dispatcher into both `CircuitBreaker` instances in `index.ts`**

Modify the breaker constructions:

```typescript
const circuitBreaker = new CircuitBreaker(
	initialConfig.circuitBreakerThreshold,
	initialConfig.circuitBreakerResetMs,
	logger,
	undefined,
	webhookDispatcher,
);
const deletionCircuitBreaker = new CircuitBreaker(
	initialConfig.circuitBreakerThreshold,
	initialConfig.circuitBreakerResetMs,
	logger,
	undefined,
	webhookDispatcher,
);
```

Note: `webhookDispatcher` must be constructed before the breakers. Move its construction up if needed.

- [ ] **Step 5: Run tests, typecheck, lint**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/circuit-breaker.ts src/runtime/circuit-breaker.test.ts src/index.ts
git commit -m "feat(webhooks): emit circuit_breaker events"
```

---

## Task 12: Emit script-runner events

**Files:**
- Modify: `src/runtime/script-runner.ts`
- Modify: `src/runtime/script-runner.test.ts`
- Modify: `src/index.ts`

Emit `script.succeeded`, `script.failed`, `script.timed_out`. Use the existing `runId` if available, otherwise generate one per call.

- [ ] **Step 1: Read `script-runner.ts` to identify success/failure/timeout sites**

Confirmed sites:
- Success: just before `resolve()` in `runCommand` (around line 332).
- Failure: `handleFailure` (lines 337+).
- Timeout: same `handleFailure` with `reason: "timeout"`.

The file does not currently produce a `runId`. Add a small generator.

- [ ] **Step 2: Add a `runId` generator helper to `src/shared/utils.ts`**

```typescript
export const generateRunId = (random: () => number = Math.random): string => {
	const part = Math.floor(random() * 0xffffff)
		.toString(16)
		.padStart(6, "0");
	return `r-${part.slice(0, 4)}`;
};
```

Add a unit test for it in `src/shared/utils.test.ts`:

```typescript
test("generateRunId returns a stable shape", () => {
	const fixed = generateRunId(() => 0.5);
	expect(fixed).toMatch(/^r-[0-9a-f]{4}$/);
});
```

- [ ] **Step 3: Update `ScriptRunner` to accept and emit on a dispatcher**

In [src/runtime/script-runner.ts](src/runtime/script-runner.ts):

Add an import:

```typescript
import type { WebhookEmitter } from "../webhooks/types";
```

Add a field and update the constructor signature:

```typescript
constructor(
	private readonly configProvider: ConfigProvider,
	private readonly logger: LoggerLike,
	private readonly metrics: Metrics,
	private readonly sleepFn: typeof sleep = sleep,
	private readonly random: () => number = Math.random,
	private readonly spawnImplementation: typeof spawn = spawn,
	private readonly dispatcher?: WebhookEmitter,
) {}
```

Generate a `runId` once per `execute()` call (top-level, not per attempt) — modify `execute` to thread `runId` down:

```typescript
async execute(
	origin: string,
	scriptMode: ScriptMode,
	attempt = 0,
	runId: string = generateRunId(this.random),
): Promise<void> {
	// ... existing body, but pass `runId` into runCommand and into recursive call ...
}
```

Pass `runId` into `runCommand` and `handleFailure`. Update those signatures. The recursive retry call:

```typescript
await this.execute(origin, scriptMode, attempt + 1, runId);
```

Inside `runCommand`, on the success path (right after `this.metrics.recordScriptSuccess(...)`):

```typescript
this.dispatcher?.emit({
	fields: { attempt: attempt + 1, durationMs, mode: scriptMode, runId },
	name: "script.succeeded",
	subject: origin,
});
```

Inside `handleFailure`, branch on the `reason` parameter:

```typescript
const config = this.configProvider.getConfig();
const isTimeout = reason === "timeout";
const isFinalAttempt = attempt >= config.maxRetries;

if (isTimeout) {
	this.dispatcher?.emit({
		fields: {
			attempt: attempt + 1,
			mode: scriptMode,
			runId,
			timeoutMs: config.scriptTimeoutMs,
		},
		name: "script.timed_out",
		subject: origin,
	});
}

if (isFinalAttempt) {
	this.dispatcher?.emit({
		fields: {
			attempts: attempt + 1,
			durationMs,
			exitCode: details.code ?? null,
			mode: scriptMode,
			runId,
		},
		name: "script.failed",
		subject: origin,
	});
}
```

`handleFailure`'s signature needs `attempt` and `runId` added — pass them from all callers.

Note: imports must include `generateRunId` from `../shared/utils`.

- [ ] **Step 4: Add a fake-dispatcher helper at the top of `script-runner.test.ts`**

Below the existing `createConfig` helper, add:

```typescript
import type { WebhookEvent } from "../webhooks/types";

const createFakeDispatcher = () => {
	const emitted: WebhookEvent[] = [];
	return {
		emit: (event: WebhookEvent) => {
			emitted.push(event);
		},
		emitted,
	};
};
```

- [ ] **Step 5: Add three fake-dispatcher tests (success, failure, timeout)**

Find the existing tests that already exercise success / failure / timeout paths (use them as templates — they each construct a `ScriptRunner`, run it, and assert outcomes). For each, append a near-copy that injects a fake dispatcher and asserts the right event was emitted. The template:

```typescript
test("emits script.succeeded on success", async () => {
	const logs: CapturedLog[] = [];
	const directory = mkdtempSync(path.join(tmpdir(), "script-success-evt-"));
	const scriptPath = writeExecutable(
		directory,
		"ok.sh",
		"#!/bin/bash\nexit 0\n",
	);
	const config = createConfig(scriptPath);
	const provider: ConfigProvider = { getConfig: () => config };
	const dispatcher = createFakeDispatcher();
	const runner = new ScriptRunner(
		provider,
		createLogger(logs),
		new Metrics(),
		async () => undefined,
		() => 0.5,
		undefined,
		dispatcher,
	);

	await runner.execute("manila", "restart");

	const success = dispatcher.emitted.find((e) => e.name === "script.succeeded");
	expect(success).toBeDefined();
	expect(success?.subject).toBe("manila");
});
```

Add analogous tests for `script.failed` (use a script that exits non-zero, set `maxRetries: 0` in the config helper override or pass enough attempts to exhaust) and `script.timed_out` (use a script that sleeps longer than `scriptTimeoutMs`). Both should:

```typescript
await expect(runner.execute("manila", "restart")).rejects.toBeInstanceOf(
	ScriptExecutionError,
);
expect(
	dispatcher.emitted.some((e) => e.name === "script.failed"),
).toBe(true);
// or for timeout: e.name === "script.timed_out"
```

- [ ] **Step 6: Wire dispatcher into `ScriptRunner` in `index.ts`**

Modify the construction:

```typescript
const scriptRunner = new ScriptRunner(
	configManager,
	logger,
	metrics,
	undefined,
	undefined,
	undefined,
	webhookDispatcher,
);
```

- [ ] **Step 7: Run tests, typecheck, lint**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/script-runner.ts src/runtime/script-runner.test.ts src/shared/utils.ts src/shared/utils.test.ts src/index.ts
git commit -m "feat(webhooks): emit script.succeeded, script.failed, script.timed_out"
```

---

## Task 13: Emit `origin.recovered` from origin-state-tracker

**Files:**
- Modify: `src/monitor/origin-state.ts`
- Modify: `src/monitor/origin-state.test.ts`
- Modify: `src/index.ts`

The `OriginStateTracker` knows when an origin's offline state is cleared on recovery. Emit `origin.recovered` from `clearOriginState` (the single-origin clear path).

- [ ] **Step 1: Confirm the state shape**

`OriginState` (in [src/monitor/types.ts](src/monitor/types.ts)) currently has only `lastSeen` and `successiveOfflineCount` — no `firstOfflineAt` or device count. So:

- `downForMs`: hard-code `0`. Plumbing a real value would require adding a `firstOfflineAt` field and updating `recordOfflineAttempt` — out of scope here. Operators still get the recovery signal; the duration can be added in a follow-up.
- `devices`: hard-code `0` for the same reason.
- `lastScript`: derive from `successiveOfflineCount >= restartThreshold ? "update" : "restart"`.
- `result`: hard-code `"success"` (we got here by observing the origin online again).

- [ ] **Step 2: Add a fake dispatcher to the existing test file**

Top of `src/monitor/origin-state.test.ts`:

```typescript
import type { WebhookEvent } from "../webhooks/types";

const createFakeDispatcher = () => {
	const emitted: WebhookEvent[] = [];
	return {
		emit: (event: WebhookEvent) => {
			emitted.push(event);
		},
		emitted,
	};
};
```

- [ ] **Step 3: Add a failing test**

```typescript
test("emits origin.recovered when clearOriginState removes a tracked origin", () => {
	const dispatcher = createFakeDispatcher();
	const tracker = new OriginStateTracker(2, undefined, {}, dispatcher);
	tracker.recordOfflineAttempt("manila", 1_000);
	tracker.clearOriginState("manila");
	const events = dispatcher.emitted.filter((e) => e.name === "origin.recovered");
	expect(events).toHaveLength(1);
	expect(events[0].subject).toBe("manila");
});

test("does not emit when clearing an origin that was never tracked", () => {
	const dispatcher = createFakeDispatcher();
	const tracker = new OriginStateTracker(2, undefined, {}, dispatcher);
	tracker.clearOriginState("never-seen");
	expect(dispatcher.emitted).toHaveLength(0);
});
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
bun test src/monitor/origin-state.test.ts
```

Expected: FAIL.

- [ ] **Step 5: Update `OriginStateTracker`**

Add the dispatcher import:

```typescript
import type { WebhookEmitter } from "../webhooks/types";
```

Modify the constructor:

```typescript
constructor(
	restartThreshold: number,
	private readonly logger?: LoggerLike,
	options: OriginStateTrackerOptions = {},
	private readonly dispatcher?: WebhookEmitter,
) {
	this.restartThreshold = restartThreshold;
	this.maxEntryAgeMs = options.maxEntryAgeMs ?? 0;
}
```

Modify `clearOriginState`:

```typescript
clearOriginState(origin: string): void {
	const state = this.states.get(origin);
	if (!state) {
		return;
	}
	this.logger?.debug({ origin }, "Clearing origin state after recovery");
	this.states.delete(origin);
	this.dispatcher?.emit({
		fields: {
			devices: 0,
			downForMs: 0,
			lastScript:
				state.successiveOfflineCount >= this.restartThreshold
					? "update"
					: "restart",
			result: "success",
		},
		name: "origin.recovered",
		subject: origin,
	});
}
```

- [ ] **Step 6: Wire dispatcher into the tracker in `index.ts`**

Modify the construction:

```typescript
const originStateTracker = new OriginStateTracker(
	initialConfig.restartThreshold,
	logger,
	{
		maxEntryAgeMs: Math.max(
			24 * 60 * 60 * 1_000,
			initialConfig.checkIntervalMs * 100,
		),
	},
	webhookDispatcher,
);
```

- [ ] **Step 7: Run tests, typecheck, lint**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/monitor/origin-state.ts src/monitor/origin-state.test.ts src/index.ts
git commit -m "feat(webhooks): emit origin.recovered from OriginStateTracker"
```

---

## Task 14: Emit `queue.saturated` from job-queue (deduped)

**Files:**
- Modify: `src/runtime/job-queue.ts`
- Modify: `src/runtime/job-queue.test.ts`
- Modify: `src/index.ts`

The queue already exposes `saturated: boolean` in its status. Emit `queue.saturated` only on the **transition** from non-saturated → saturated (avoids spam each time a duplicate is rejected while saturated).

- [ ] **Step 1: Add a fake-dispatcher test**

Open [src/runtime/job-queue.test.ts](src/runtime/job-queue.test.ts) and add the fake-dispatcher helper at the top (same shape as the previous tasks).

Add a test:

```typescript
test("emits queue.saturated once on transition to saturated", async () => {
	const dispatcher = createFakeDispatcher();
	const queue = new JobQueue(1, logger, undefined, {}, dispatcher);
	const block = new Promise<void>(() => undefined); // never resolves
	queue.add(() => block, "origin-A");
	queue.add(() => block, "origin-B");

	const saturatedEvents = dispatcher.emitted.filter(
		(e) => e.name === "queue.saturated",
	);
	expect(saturatedEvents).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test src/runtime/job-queue.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update `JobQueue`**

Add types and a state field:

```typescript
import type { WebhookEmitter } from "../webhooks/types";
```

Modify the constructor signature (add `dispatcher` as the 5th arg):

```typescript
constructor(
	concurrency: number,
	private readonly logger: LoggerLike,
	private readonly observer?: QueueStatusObserver,
	options: JobQueueOptions = {},
	private readonly dispatcher?: WebhookEmitter,
) {
	this.concurrency = concurrency;
	this.stuckJobTimeoutMs = options.stuckJobTimeoutMs ?? 0;
}
```

Add a saturation-state tracker:

```typescript
private wasSaturated = false;
```

Inside `notifyStatusChanged`, after the existing observer call, add transition detection:

```typescript
private notifyStatusChanged(): void {
	const status = this.getStatus();
	this.observer?.updateQueueStatus(status);

	if (status.saturated && !this.wasSaturated) {
		this.wasSaturated = true;
		this.dispatcher?.emit({
			fields: {
				capacity: status.capacity,
				queued: status.queued,
				rejected: this.duplicateRejectedTotal,
				running: status.running,
			},
			name: "queue.saturated",
			subject: "job-queue",
		});
	} else if (!status.saturated && this.wasSaturated) {
		this.wasSaturated = false;
	}
}
```

If `notifyStatusChanged` does not yet exist as a single helper, refactor to introduce it (the existing `this.observer?.updateQueueStatus(this.getStatus())` calls become `this.notifyStatusChanged()`).

- [ ] **Step 4: Wire dispatcher in `index.ts`**

```typescript
const jobQueue = new JobQueue(
	initialConfig.maxConcurrentJobs,
	logger,
	metrics,
	{ stuckJobTimeoutMs },
	webhookDispatcher,
);
```

- [ ] **Step 5: Run tests, typecheck, lint**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/job-queue.ts src/runtime/job-queue.test.ts src/index.ts
git commit -m "feat(webhooks): emit queue.saturated on transition"
```

---

## Task 15: Emit device-monitor events

**Files:**
- Modify: `src/monitor/device-monitor.ts`
- Modify: `src/monitor/device-monitor.test.ts`
- Modify: `src/index.ts`

Five events live here:
- `origin.offline.restart` / `origin.offline.update` — at the offline-detected emit site.
- `poll.failed` — in the catch block of the poll loop.
- `device.duplicate_deleted` — in the per-deletion success branch.
- `group.pipeline.triggered` — in the group-pipeline branch.

- [ ] **Step 1: Add `dispatcher` to the `DeviceMonitorDependencies` interface**

In [src/monitor/device-monitor.ts](src/monitor/device-monitor.ts), find the dependencies interface and add:

```typescript
import type { WebhookEmitter } from "../webhooks/types";

// Inside the deps interface:
dispatcher?: WebhookEmitter;
```

- [ ] **Step 2: Emit `origin.offline.{restart,update}` at the offline-detection site**

In the existing block where `originStateTracker.recordOfflineAttempt` is called (around [device-monitor.ts:205](src/monitor/device-monitor.ts:205)), add right after the `logger.warn` for "Scheduling recovery script":

```typescript
const eventName =
	offlineAttempt.scriptMode === "update"
		? "origin.offline.update"
		: "origin.offline.restart";

if (eventName === "origin.offline.update") {
	this.dependencies.dispatcher?.emit({
		fields: {
			devices: 0,
			lastSeenMs: decision.lastSeenMinutes * 60_000,
			mode: "update",
			offlineStreak: offlineAttempt.state.successiveOfflineCount,
		},
		name: "origin.offline.update",
		subject: decision.origin,
	});
} else {
	this.dependencies.dispatcher?.emit({
		fields: {
			attempt: offlineAttempt.state.successiveOfflineCount,
			devices: 0,
			lastSeenMs: decision.lastSeenMinutes * 60_000,
			mode: "restart",
		},
		name: "origin.offline.restart",
		subject: decision.origin,
	});
}
```

Note: `OriginDecision` does not currently carry a per-origin device count. Hard-code `devices: 0` for now; plumbing the real count is a follow-up.

- [ ] **Step 3: Emit `poll.failed` in the catch block**

Around [device-monitor.ts:290](src/monitor/device-monitor.ts:290) where `circuitBreaker.recordFailure()` and the error log happen, add:

```typescript
this.dependencies.dispatcher?.emit({
	fields: {
		durationMs: now() - pollStartedAt,
		reason: error instanceof Error ? error.message : "unknown",
	},
	name: "poll.failed",
	subject: "rotom-api",
});
```

- [ ] **Step 4: Emit `device.duplicate_deleted` after each successful deletion**

In the success branch of the deletion loop (around [device-monitor.ts:165](src/monitor/device-monitor.ts:165)), after the `logger.info` "Deleted dead duplicate device" line, add:

```typescript
this.dependencies.dispatcher?.emit({
	fields: { deviceId: device.deviceId, origin: device.origin },
	name: "device.duplicate_deleted",
	subject: device.origin,
});
```

- [ ] **Step 5: Emit `group.pipeline.triggered` in the group branch**

Around [device-monitor.ts:259](src/monitor/device-monitor.ts:259) where `metrics.recordGroupPipelineTriggered(group.prefix)` is called, add:

```typescript
this.dependencies.dispatcher?.emit({
	fields: {
		groupSize: group.members.length,
		trigger: "fully-dead-group",
	},
	name: "group.pipeline.triggered",
	subject: group.prefix,
});
```

- [ ] **Step 6: Add fake-dispatcher tests**

In [src/monitor/device-monitor.test.ts](src/monitor/device-monitor.test.ts), add the `createFakeDispatcher` helper and add four tests — one per emitted event — using the existing test scaffolding for setting up the monitor. Use the existing tests as templates; each new test injects `dispatcher` into the deps and asserts `dispatcher.emitted` contains the expected event name and subject after running a poll.

Example shape:

```typescript
test("emits origin.offline.restart when an origin enters offline state", async () => {
	const dispatcher = createFakeDispatcher();
	// ... build monitor with a status fixture that produces an offline origin ...
	const monitor = new DeviceMonitor({ ...baseDeps, dispatcher });
	// trigger one poll cycle (use the same helper existing tests use)
	expect(
		dispatcher.emitted.some((e) => e.name === "origin.offline.restart"),
	).toBe(true);
});
```

- [ ] **Step 7: Wire dispatcher into the monitor in `index.ts`**

Modify the `new DeviceMonitor({...})` call to add:

```typescript
dispatcher: webhookDispatcher,
```

- [ ] **Step 8: Run tests, typecheck, lint**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/monitor/device-monitor.ts src/monitor/device-monitor.test.ts src/index.ts
git commit -m "feat(webhooks): emit device-monitor events"
```

---

## Task 16: Update `config.toml.example`

**Files:**
- Modify: `config.toml.example`

- [ ] **Step 1: Append the `[webhooks]` block**

Append to [config.toml.example](config.toml.example):

```toml

[webhooks]
discord = []                       # Discord webhook URLs

# All available events. Uncomment any you want delivered.
events = [
  # Critical (4) — pinged via mention_role_id when set
  # "circuit_breaker.opened",
  # "origin.offline.update",
  # "queue.saturated",
  # "script.failed",

  # Warning (4)
  # "circuit_breaker.half_open",
  # "origin.offline.restart",
  # "poll.failed",
  # "script.timed_out",

  # Success (3)
  # "circuit_breaker.closed",
  # "origin.recovered",
  # "script.succeeded",

  # Info (4)
  # "device.duplicate_deleted",
  # "group.pipeline.triggered",
  # "service.started",
  # "service.stopping",
]

mention_role_id        = ""        # Discord role ID; pinged ONLY on Critical events
coalesce_window_ms     = 10000     # 0 disables coalescing
retry_attempts         = 3
retry_initial_delay_ms = 500
username               = "rotom-watcher"
avatar_url             = ""
```

- [ ] **Step 2: Verify the file still parses**

Copy and run a config validation pass:

```bash
cp config.toml.example /tmp/test-config.toml
ROTOM_API_BASE_URL=https://example.invalid ROTOM_CONFIG_PATH=/tmp/test-config.toml bun run src/index.ts &
PID=$!
sleep 1
kill $PID
```

Expected: clean startup (no config validation errors).

- [ ] **Step 3: Commit**

```bash
git add config.toml.example
git commit -m "docs(config): document webhooks config in example"
```

---

## Task 17: Update README.md

**Files:**
- Modify: `README.md`

Document the webhooks integration end-to-end: config, the event catalog with severity, examples, env var equivalents, and the metrics added.

- [ ] **Step 1: Read the current README structure**

```bash
cat README.md
```

Find the right section to insert under (likely after the existing "Configuration" section).

- [ ] **Step 2: Append a new section "Discord Webhooks"**

Add this section before the closing of the document:

````markdown
## Discord Webhooks

Optional. When enabled, `rotom-watcher` posts richly-formatted Discord embeds for selected events. Nothing is enabled by default — you opt in event-by-event.

### Configuration

```toml
[webhooks]
discord                = ["https://discord.com/api/webhooks/..."]
events                 = ["origin.offline.update", "script.failed"]
mention_role_id        = ""        # Discord role ID; pinged ONLY on Critical events
coalesce_window_ms     = 10000     # 0 disables coalescing
retry_attempts         = 3
retry_initial_delay_ms = 500
username               = "rotom-watcher"
avatar_url             = ""
```

Environment variable equivalents (comma-separated for arrays): `WEBHOOKS_DISCORD`, `WEBHOOKS_EVENTS`, `WEBHOOKS_MENTION_ROLE_ID`, `WEBHOOKS_COALESCE_WINDOW_MS`, `WEBHOOKS_RETRY_ATTEMPTS`, `WEBHOOKS_RETRY_INITIAL_DELAY_MS`, `WEBHOOKS_USERNAME`, `WEBHOOKS_AVATAR_URL`.

### Event reference

| Event | Severity | Description |
|---|---|---|
| `circuit_breaker.opened` | 🔥 Critical | Rotom API failures hit threshold; circuit opened |
| `origin.offline.update` | 🔥 Critical | Origin escalated to `update` after repeated restart failures |
| `queue.saturated` | 🔥 Critical | Job queue full; transitioned to saturated state |
| `script.failed` | 🔥 Critical | Recovery script exhausted retries |
| `circuit_breaker.half_open` | ⚠️ Warning | Circuit testing recovery |
| `origin.offline.restart` | ⚠️ Warning | Origin offline detected; running restart script |
| `poll.failed` | ⚠️ Warning | A single Rotom API poll failed |
| `script.timed_out` | ⚠️ Warning | Recovery script killed for exceeding timeout |
| `circuit_breaker.closed` | ✅ Success | Circuit returned to healthy |
| `origin.recovered` | ✅ Success | Origin came back online |
| `script.succeeded` | ✅ Success | Recovery script completed OK |
| `device.duplicate_deleted` | ℹ️ Info | Dead duplicate device cleaned up |
| `group.pipeline.triggered` | ℹ️ Info | Group recovery pipeline kicked in |
| `service.started` | ℹ️ Info | Service started |
| `service.stopping` | ℹ️ Info | Graceful shutdown begun |

### Behavior

- **Routing**: every URL in `discord` receives every enabled event.
- **Coalescing**: same-name events arriving within `coalesce_window_ms` are merged into one embed listing the affected subjects (up to 20, then `+ N more`).
- **Mentions**: when `mention_role_id` is set, **Critical** events ping that role via Discord's `allowed_mentions` (no `@everyone`/other roles can leak).
- **Retries**: 5xx, 429, network errors, and timeouts retry up to `retry_attempts` with exponential backoff (`retry_initial_delay_ms × 2^n`). 429 honors `Retry-After`. Other 4xx drops without retry.
- **Disable**: leave the section out, or set `discord = []` or `events = []`.

### Metrics

Three counters are exposed on the existing `/metrics` endpoint:

| Metric | Labels |
|---|---|
| `rotom_watcher_webhook_events_delivered_total` | `event`, `severity` |
| `rotom_watcher_webhook_events_failed_total` | `event`, `reason` (`5xx_exhausted`, `4xx`, `network_exhausted`, `429_exhausted`) |
| `rotom_watcher_webhook_events_coalesced_total` | `event` |
````

- [ ] **Step 3: Verify Markdown renders cleanly**

```bash
# If you have a Markdown preview tool, use it. Otherwise just spot-check
# in your editor that the table renders.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document Discord webhooks integration"
```

---

## Final verification

- [ ] **Step 1: Run the full suite**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 2: Smoke test against a live config**

```bash
cp config.toml.example /tmp/rotom-test.toml
# Edit /tmp/rotom-test.toml: set rotom_api.base_url, set webhooks.discord = ["..."],
# enable a couple of events, set mention_role_id if testing pings.
ROTOM_CONFIG_PATH=/tmp/rotom-test.toml bun run src/index.ts
```

Expected: `service.started` embed appears in Discord shortly after launch.

- [ ] **Step 3: Hot-reload sanity check**

While the service is running, edit the live config to remove all events from `webhooks.events`. The next emit should become a no-op (no further posts). Note: hot-reload of webhooks config only takes effect on next dispatcher construction unless the manager subscribes to webhook keys; if not implemented, restart for the change to apply. This is acceptable for the initial release — leave a note in the design.

- [ ] **Step 4: Final commit if any small fixes were needed**

If verification surfaced any small fixes, commit them with a message like `fix(webhooks): <whatever>`.

---

## Self-review checklist (run before handing off)

- [ ] Every event in [src/webhooks/events.ts](src/webhooks/events.ts) `EVENT_NAMES` has a renderer in [src/webhooks/discord-transport.ts](src/webhooks/discord-transport.ts) `RENDERERS`.
- [ ] Every event in `EVENT_NAMES` is emitted from at least one site in the codebase.
- [ ] The `Config` type, the Zod schema, the env mapping, and the example TOML all agree on key names.
- [ ] No `TODO`, `TBD`, or unreferenced types remain.
- [ ] `bun test`, `bun run typecheck`, and `bun run lint` are all clean.
