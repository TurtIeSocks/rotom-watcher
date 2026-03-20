import { describe, expect, test } from "bun:test";

import type { LoggerLike } from "./logger";
import { Metrics } from "./metrics";
import { ObservabilityServer } from "./observability-server";

const logger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

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
});
