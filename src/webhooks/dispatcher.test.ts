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

	test("flush leaves pending empty (no orphaned tracking)", async () => {
		const { transport } = createFakeTransport();
		const dispatcher = new WebhookDispatcher({
			config: baseConfig,
			logger: silentLogger,
			transport,
		});
		dispatcher.emit(exampleEvent);
		dispatcher.emit(exampleEvent);
		await dispatcher.flush();

		// Reach in via casting — this is a white-box regression test for the
		// cleanup chain. After flush returns, pending must be empty.
		const internalPending = (
			dispatcher as unknown as {
				pending: Set<Promise<void>>;
			}
		).pending;
		expect(internalPending.size).toBe(0);
	});

	test("flush drains emits issued during the flush", async () => {
		let resolveFirst!: () => void;
		const firstSend = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const sentBatches: number[] = [];
		const transport: WebhookTransport = {
			send: async (batch) => {
				sentBatches.push(batch.length);
				if (sentBatches.length === 1) {
					await firstSend;
				}
			},
		};
		const dispatcher = new WebhookDispatcher({
			config: baseConfig,
			logger: silentLogger,
			transport,
		});

		dispatcher.emit(exampleEvent);
		const flushPromise = dispatcher.flush();
		// Emit a second event while the first is still in-flight (i.e., during the
		// flush). The drain loop must wait for it too.
		dispatcher.emit(exampleEvent);
		resolveFirst();
		await flushPromise;

		expect(sentBatches).toHaveLength(2);
	});
});
