import { describe, expect, test } from "bun:test";
import type { Device, Worker } from "../rotom/types";
import { evaluateDevices } from "./device-evaluation";

const buildDevice = (overrides: Partial<Device> = {}): Device => ({
	dateConnected: 0,
	dateLastMessageReceived: 0,
	dateLastMessageSent: 0,
	deviceId: "device-1",
	heartbeatCheckStatus: true,
	init: true,
	instanceNo: 1,
	isAlive: true,
	lastMemory: {
		memFree: 0,
		memMitm: 0,
		memStart: 0,
	},
	nextId: 0,
	noMessagesReceived: 0,
	noMessagesSent: 0,
	origin: "alpha",
	publicIp: "127.0.0.1",
	version: 1,
	...overrides,
});

const buildWorker = (origin: string): Worker => ({
	deviceId: `${origin}-device`,
	isAllocated: true,
	worker: {
		dateLastMessageReceived: 0,
		dateLastMessageSent: 0,
		deviceId: `${origin}-device`,
		heartbeatCheckStatus: true,
		init: true,
		instanceNo: 1,
		isAlive: true,
		noMessagesReceived: 0,
		noMessagesSent: 0,
		origin,
		traceMessages: false,
		userAgent: "rotom-worker",
		version: "1.0.0",
		workerId: `${origin}-worker`,
	},
	workerId: `${origin}-worker`,
});

describe("evaluateDevices", () => {
	test("marks alive devices with workers as online and skips processing", () => {
		const result = evaluateDevices({
			currentTimeMs: 60_000,
			deviceTimeoutMinutes: 10,
			devices: [
				buildDevice({
					dateLastMessageReceived: 59_000,
				}),
			],
			workers: [buildWorker("alpha")],
		});

		expect(result.onlineOrigins).toEqual(["alpha"]);
		expect(result.originDecisions).toEqual([
			{
				deadDuplicatesToDelete: [],
				hasAliveDevice: true,
				hasWorkers: true,
				lastSeenMinutes: 1 / 60,
				origin: "alpha",
				shouldProcess: false,
			},
		]);
	});

	test("marks stale origins with workers for processing once", () => {
		const result = evaluateDevices({
			currentTimeMs: 11 * 60 * 1_000,
			deviceTimeoutMinutes: 10,
			devices: [
				buildDevice({
					dateLastMessageReceived: 0,
					isAlive: false,
				}),
				buildDevice({
					dateLastMessageReceived: 60_000,
					deviceId: "alpha-stale-2",
					isAlive: false,
				}),
			],
			workers: [buildWorker("alpha")],
		});

		expect(result.onlineOrigins).toEqual([]);
		expect(result.originDecisions).toEqual([
			{
				deadDuplicatesToDelete: [],
				hasAliveDevice: false,
				hasWorkers: true,
				lastSeenMinutes: 10,
				origin: "alpha",
				shouldProcess: false,
			},
		]);
	});

	test("processes origins without workers immediately using the freshest device timestamp", () => {
		const result = evaluateDevices({
			currentTimeMs: 60_000,
			deviceTimeoutMinutes: 10,
			devices: [
				buildDevice({
					dateLastMessageReceived: 0,
					deviceId: "alpha-dead",
					isAlive: false,
				}),
				buildDevice({
					dateLastMessageReceived: 59_000,
					deviceId: "alpha-alive",
					isAlive: true,
				}),
			],
			workers: [] satisfies Worker[],
		});

		expect(result.originDecisions).toEqual([
			{
				deadDuplicatesToDelete: [],
				hasAliveDevice: true,
				hasWorkers: false,
				lastSeenMinutes: 1 / 60,
				origin: "alpha",
				shouldProcess: true,
			},
		]);
	});

	test("deletes dead duplicates when an origin is still online", () => {
		const result = evaluateDevices({
			currentTimeMs: 60_000,
			deviceTimeoutMinutes: 10,
			devices: [
				buildDevice({
					deviceId: "alpha-dead",
					dateLastMessageReceived: 0,
					isAlive: false,
				}),
				buildDevice({
					deviceId: "alpha-alive",
					dateLastMessageReceived: 59_000,
					isAlive: true,
				}),
			],
			workers: [buildWorker("alpha")],
		});

		expect(result.originDecisions).toEqual([
			{
				deadDuplicatesToDelete: [
					{
						deviceId: "alpha-dead",
						origin: "alpha",
					},
				],
				hasAliveDevice: true,
				hasWorkers: true,
				lastSeenMinutes: 1 / 60,
				origin: "alpha",
				shouldProcess: false,
			},
		]);
	});

	test("sorts origin decisions and online origins across multiple origins", () => {
		const result = evaluateDevices({
			currentTimeMs: 60_000,
			deviceTimeoutMinutes: 10,
			devices: [
				buildDevice({
					deviceId: "zeta-alive",
					origin: "zeta",
					dateLastMessageReceived: 59_000,
				}),
				buildDevice({
					deviceId: "beta-dead",
					origin: "beta",
					dateLastMessageReceived: 0,
					isAlive: false,
				}),
				buildDevice({
					deviceId: "alpha-alive",
					origin: "alpha",
					dateLastMessageReceived: 58_000,
				}),
			],
			workers: [buildWorker("zeta"), buildWorker("alpha")],
		});

		expect(result.onlineOrigins).toEqual(["alpha", "zeta"]);
		expect(result.originDecisions.map((decision) => decision.origin)).toEqual([
			"alpha",
			"beta",
			"zeta",
		]);
	});
});
