import { describe, expect, test } from "bun:test";

import { Metrics } from "./metrics";

describe("Metrics", () => {
	test("tracks readiness, shutdown, and renders counters", async () => {
		const metrics = new Metrics();

		expect(metrics.getHealthSnapshot()).toEqual({
			healthy: true,
			lastSuccessfulPollTimestamp: null,
			ready: false,
			shutdownRequested: false,
		});

		metrics.recordApiRequest("fetch_status", "failure", 25, "timeout");
		metrics.recordDuplicateDeletion("success");
		metrics.recordPollDuration(100);
		metrics.recordPollSuccess(2_000);
		metrics.recordScriptAttempt("restart");
		metrics.recordScriptRetry("restart");
		metrics.recordScriptFailure("restart", 50, "timeout");
		metrics.recordScriptSuccess("update", 75);
		metrics.markShutdownRequested();

		expect(metrics.getHealthSnapshot()).toEqual({
			healthy: false,
			lastSuccessfulPollTimestamp: 2_000,
			ready: false,
			shutdownRequested: true,
		});
		expect(metrics.getContentType()).toContain("text/plain");

		const output = await metrics.render();

		expect(output).toContain("rotom_watcher_api_requests_total");
		expect(output).toContain("rotom_watcher_api_failures_total");
		expect(output).toContain("rotom_watcher_script_failures_total");
		expect(output).toContain("rotom_watcher_duplicate_deletions_total");
		expect(output).toContain(
			"rotom_watcher_last_successful_poll_timestamp_seconds",
		);
	});
});
