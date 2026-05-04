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

	test("flush leaves pending empty (cleanup chain regression guard)", async () => {
		const { transport } = createFakeTransport();
		const dispatcher = new WebhookDispatcher({
			config: baseConfig,
			logger: silentLogger,
			transport,
		});
		dispatcher.emit(exampleEvent);
		dispatcher.emit(exampleEvent);
		await dispatcher.flush();

		// White-box check: cleanup must remove finished promises from `pending`.
		// Without this guard the drain loop in flush() would still work for one
		// flush, but `pending` would grow unbounded across the lifetime of the
		// dispatcher.
		const internalPending = (
			dispatcher as unknown as { pending: Set<Promise<void>> }
		).pending;
		expect(internalPending.size).toBe(0);
	});

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
			const due = timers.splice(0);
			for (const t of due) {
				if (t.at <= now) {
					t.fn();
				} else {
					timers.push(t);
				}
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

		const eventA: WebhookEvent = { ...exampleEvent, subject: "manila" };
		const eventB: WebhookEvent = { ...exampleEvent, subject: "cebu" };
		dispatcher.emit(eventA);
		dispatcher.emit(eventB);

		expect(batches).toHaveLength(0);
		advance(1000);
		await dispatcher.flush();

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(batches[0]![0]!.subject).toBe("manila");
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(batches[0]![1]!.subject).toBe("cebu");
	});

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
			const due = timers.splice(0);
			for (const t of due) {
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
			const due = timers.splice(0);
			for (const t of due) {
				if (t.at <= now) {
					t.fn();
				} else {
					timers.push(t);
				}
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
});
