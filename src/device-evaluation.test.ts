import { describe, expect, test } from "bun:test";

import { evaluateDevices } from "./device-evaluation";
import type { ConnectionInfo, StatusWorker } from "./types";

const buildDevice = (
	overrides: Partial<ConnectionInfo> = {},
): ConnectionInfo => ({
	dateConnected: 0,
	dateLastMessageReceived: 0,
	dateLastMessageSent: 0,
	deviceId: "device-1",
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

const buildWorker = (origin: string): StatusWorker => ({
	worker: buildDevice({
		deviceId: `${origin}-worker`,
		origin,
	}),
});

describe("evaluateDevices", () => {
	test("treats alive devices with workers as online", () => {
		const device = buildDevice({
			dateLastMessageReceived: 59_000,
		});

		const result = evaluateDevices({
			currentTimeMs: 60_000,
			deviceTimeoutMinutes: 10,
			devices: [device],
			workers: [buildWorker("alpha")],
		});

		expect(result.onlineOrigins).toEqual(["alpha"]);
		expect(result.devicesToProcess).toEqual([]);
	});

	test("queues stale offline devices", () => {
		const device = buildDevice({
			dateLastMessageReceived: 0,
			isAlive: false,
		});

		const result = evaluateDevices({
			currentTimeMs: 11 * 60 * 1_000,
			deviceTimeoutMinutes: 10,
			devices: [device],
			workers: [buildWorker("alpha")],
		});

		expect(result.onlineOrigins).toEqual([]);
		expect(result.devicesToProcess).toEqual([
			{
				origin: "alpha",
				timeDifference: "11.00",
			},
		]);
	});

	test("queues devices without workers immediately", () => {
		const device = buildDevice({
			dateLastMessageReceived: 59_000,
		});

		const result = evaluateDevices({
			currentTimeMs: 60_000,
			deviceTimeoutMinutes: 10,
			devices: [device],
			workers: [] satisfies StatusWorker[],
		});

		expect(result.devicesToProcess).toEqual([
			{
				origin: "alpha",
				timeDifference: "0.02",
			},
		]);
	});
});
