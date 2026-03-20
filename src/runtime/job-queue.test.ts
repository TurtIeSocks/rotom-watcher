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
