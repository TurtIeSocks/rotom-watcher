import { describe, expect, test } from "bun:test";

import { OriginStateTracker } from "./origin-state";

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
