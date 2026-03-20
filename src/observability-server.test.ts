import { afterEach, describe, expect, test } from "bun:test";

import type { LoggerLike } from "./logger";
import { Metrics } from "./metrics";
import { ObservabilityServer } from "./observability-server";

const logger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

const originalServe = Bun.serve;

afterEach(() => {
	Bun.serve = originalServe;
});

describe("ObservabilityServer", () => {
	test("reports health and readiness separately", async () => {
		const metrics = new Metrics();
		const server = new ObservabilityServer("127.0.0.1", 9_090, logger, metrics);

		const healthResponse = await server.handleRequest(
			new Request("http://localhost/healthz"),
		);
		const readyBeforePoll = await server.handleRequest(
			new Request("http://localhost/readyz"),
		);

		metrics.recordPollSuccess(1_000);

		const readyAfterPoll = await server.handleRequest(
			new Request("http://localhost/readyz"),
		);

		expect(healthResponse.status).toBe(200);
		expect(readyBeforePoll.status).toBe(503);
		expect(readyAfterPoll.status).toBe(200);
	});

	test("renders prometheus metrics", async () => {
		const metrics = new Metrics();
		const server = new ObservabilityServer("127.0.0.1", 9_090, logger, metrics);
		const response = await server.handleRequest(
			new Request("http://localhost/metrics"),
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain("rotom_watcher_poll_duration_seconds");
	});

	test("returns 404 for unknown routes", async () => {
		const metrics = new Metrics();
		const server = new ObservabilityServer("127.0.0.1", 9_090, logger, metrics);
		const response = await server.handleRequest(new Request("http://localhost/nope"));
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body).toEqual({
			error: "Not found",
		});
	});

	test("starts once and stops safely", () => {
		let stopCalls = 0;
		let serveCalls = 0;

		Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
			serveCalls++;
			expect(typeof options.error).toBe("function");

			return {
				port: 9_090,
				stop: () => {
					stopCalls++;
				},
			} as unknown as ReturnType<typeof Bun.serve>;
		}) as typeof Bun.serve;

		const metrics = new Metrics();
		const server = new ObservabilityServer("127.0.0.1", 9_090, logger, metrics);

		server.start();
		server.start();
		server.stop();
		server.stop();

		expect(serveCalls).toBe(1);
		expect(stopCalls).toBe(1);
	});

	test("exposes the serve error handler", async () => {
		let errorHandler:
			| ((
					error: unknown,
			  ) => Response | Promise<Response> | void | Promise<void>)
			| undefined;

		Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
			errorHandler = options.error as typeof errorHandler;
			return {
				port: 9_090,
				stop: () => undefined,
			} as unknown as ReturnType<typeof Bun.serve>;
		}) as typeof Bun.serve;

		const metrics = new Metrics();
		const server = new ObservabilityServer("127.0.0.1", 9_090, logger, metrics);

		server.start();

		const response = await errorHandler?.(new Error("boom"));

		expect(response?.status).toBe(500);
		expect(await response?.json()).toEqual({
			error: "Internal server error",
		});
	});
});
