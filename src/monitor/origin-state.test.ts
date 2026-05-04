import { describe, expect, test } from "bun:test";

import type { WebhookEvent } from "../webhooks/types";
import { OriginStateTracker } from "./origin-state";

const createFakeDispatcher = () => {
	const emitted: WebhookEvent[] = [];
	return {
		emit: (event: WebhookEvent) => {
			emitted.push(event);
		},
		emitted,
	};
};

describe("OriginStateTracker", () => {
	test("starts with restart for newly offline origins", () => {
		const tracker = new OriginStateTracker(2);

		expect(tracker.getScriptMode("alpha")).toBe("restart");
	});

	test("switches to update after the restart threshold is reached", () => {
		const tracker = new OriginStateTracker(2);

		tracker.recordOfflineAttempt("alpha", 1_000);
		expect(tracker.getScriptMode("alpha")).toBe("restart");

		tracker.recordOfflineAttempt("alpha", 2_000);
		expect(tracker.getScriptMode("alpha")).toBe("update");
	});

	test("clears tracked state when an origin comes back online", () => {
		const tracker = new OriginStateTracker(2);

		tracker.recordOfflineAttempt("alpha", 1_000);
		tracker.cleanupOnlineOrigins(["alpha"]);

		expect(tracker.getState("alpha")).toBeUndefined();
		expect(tracker.getStats()).toEqual({
			totalTracked: 0,
			byCount: {},
		});
	});

	test("emits origin.recovered when clearOriginState removes a tracked origin", () => {
		const dispatcher = createFakeDispatcher();
		const tracker = new OriginStateTracker(2, undefined, {}, dispatcher);
		tracker.recordOfflineAttempt("manila", 1_000);
		tracker.clearOriginState("manila");
		const events = dispatcher.emitted.filter(
			(e) => e.name === "origin.recovered",
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.subject).toBe("manila");
	});

	test("does not emit when clearing an origin that was never tracked", () => {
		const dispatcher = createFakeDispatcher();
		const tracker = new OriginStateTracker(2, undefined, {}, dispatcher);
		tracker.clearOriginState("never-seen");
		expect(dispatcher.emitted).toHaveLength(0);
	});

	test("updates thresholds and reports stats for tracked origins", () => {
		const tracker = new OriginStateTracker(3);

		tracker.recordOfflineAttempt("alpha", 1_000);
		tracker.recordOfflineAttempt("alpha", 2_000);
		tracker.recordOfflineAttempt("beta", 3_000);

		expect(tracker.getStats()).toEqual({
			byCount: {
				"1": 1,
				"2": 1,
			},
			totalTracked: 2,
		});
		expect(tracker.getScriptMode("alpha")).toBe("restart");

		tracker.setRestartThreshold(2);
		expect(tracker.getScriptMode("alpha")).toBe("update");

		tracker.clearOriginState("missing-origin");
		expect(tracker.getStats().totalTracked).toBe(2);
	});
});
