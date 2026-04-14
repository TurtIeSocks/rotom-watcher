import { describe, expect, test } from "bun:test";
import type { LoggerLike } from "../observability/logger";
import { JobQueue } from "./job-queue";

const logger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

describe("JobQueue", () => {
	test("rejects duplicate jobs for an origin while work is in progress", async () => {
		let releaseFirstJob: (() => void) | undefined;
		const queue = new JobQueue(1, logger);

		const firstJob = queue.add(
			() =>
				new Promise<void>((resolve) => {
					releaseFirstJob = resolve;
				}),
			"alpha",
		);

		await queue.add(async () => undefined, "alpha");

		expect(queue.getStatus()).toMatchObject({
			duplicateRejectedTotal: 1,
		});

		releaseFirstJob?.();
		await firstJob;
	});

	test("watchdog releases a stuck origin slot so future jobs for that origin run", async () => {
		const errorLogs: unknown[] = [];
		const capturingLogger: LoggerLike = {
			debug: () => undefined,
			error: (...args: unknown[]) => {
				errorLogs.push(args);
			},
			info: () => undefined,
			warn: () => undefined,
		};

		const queue = new JobQueue(1, capturingLogger, undefined, {
			stuckJobTimeoutMs: 25,
		});

		// First job never resolves — simulates a leaked promise that would
		// otherwise pin "alpha" in `inProgress` forever.
		const stuckJob = queue.add(() => new Promise<void>(() => undefined), "alpha");

		// Wait past the watchdog to let it fire.
		await new Promise<void>((resolve) => setTimeout(resolve, 80));

		const status = queue.getStatus();
		expect(status.activeOrigins).not.toContain("alpha");
		expect(errorLogs.length).toBeGreaterThan(0);

		// A subsequent job for the same origin must now run instead of being
		// rejected as a duplicate.
		let secondJobRan = false;
		await queue.add(async () => {
			secondJobRan = true;
		}, "alpha");

		expect(secondJobRan).toBe(true);

		// Keep the stuck promise reference alive so GC doesn't complain; we
		// deliberately never resolve it.
		void stuckJob;
	});

	test("reprocesses the queue after concurrency increases", async () => {
		let releaseFirstJob: (() => void) | undefined;
		let secondJobStarted = false;
		const queue = new JobQueue(1, logger);

		const firstJob = queue.add(
			() =>
				new Promise<void>((resolve) => {
					releaseFirstJob = resolve;
				}),
			"alpha",
		);
		const secondJob = queue.add(async () => {
			secondJobStarted = true;
		}, "beta");

		expect(secondJobStarted).toBe(false);

		queue.setConcurrency(2);

		expect(secondJobStarted).toBe(true);
		expect(queue.getStatus().capacity).toBe(2);

		releaseFirstJob?.();
		await Promise.all([firstJob, secondJob]);
	});
});
