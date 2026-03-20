import { afterEach, describe, expect, test } from "bun:test";
import { CircuitBreaker } from "./circuit-breaker";
import type { Config, ConfigProvider } from "./config";
import { DeviceMonitor } from "./device-monitor";
import { JobQueue } from "./job-queue";
import type { LoggerLike } from "./logger";
import { Metrics } from "./metrics";
import { OriginStateTracker } from "./origin-state";
import { RotomApiClient } from "./rotom-api";
import { ScriptRunner } from "./script-runner";
import type { ConnectionInfo, ScriptMode, StatusResponse } from "./types";

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

const config: Config = {
	checkIntervalMs: 60_000,
	circuitBreakerResetMs: 60_000,
	circuitBreakerThreshold: 5,
	deviceTimeoutMinutes: 10,
	fetchTimeoutMs: 1_000,
	initialRetryDelayMs: 100,
	logFormat: "json",
	logLevel: "info",
	maxConcurrentJobs: 2,
	maxRetries: 0,
	maxRetryDelayMs: 1_000,
	metricsHost: "127.0.0.1",
	metricsPort: 9_090,
	restartThreshold: 2,
	rotomApiBaseUrl: "https://example.com/",
	scriptPath: "/tmp/test-script.sh",
	scriptRestart: "-rsc",
	scriptTimeoutMs: 1_000,
	scriptUpdate: "-usc",
	shutdownGracePeriodMs: 500,
};

const logger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

afterEach(() => {
	globalThis.setTimeout = originalSetTimeout;
	globalThis.clearTimeout = originalClearTimeout;
});

class TestStatusApiClient extends RotomApiClient {
	fetchCalls = 0;

	constructor(
		private readonly response: StatusResponse,
		private readonly deletedDeviceIds: string[],
	) {
		super(createConfigProvider(config));
	}

	override async fetchStatus(): Promise<StatusResponse> {
		this.fetchCalls++;
		return this.response;
	}

	override async deleteDevice(deviceId: string): Promise<boolean> {
		this.deletedDeviceIds.push(deviceId);
		return true;
	}
}

class TestScriptRunner extends ScriptRunner {
	readonly executed: Array<{ origin: string; scriptMode: ScriptMode }> = [];

	constructor() {
		super(createConfigProvider(config), logger, new Metrics());
	}

	override async execute(
		origin: string,
		scriptMode: ScriptMode,
	): Promise<void> {
		this.executed.push({
			origin,
			scriptMode,
		});
	}
}

describe("DeviceMonitor", () => {
	test("deletes dead duplicates for origins that still have an online device", async () => {
		const deletedDeviceIds: string[] = [];
		const scriptRunner = new TestScriptRunner();
		const monitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(5, 60_000, logger, () => 60_000),
			configProvider: createConfigProvider(config),
			jobQueue: new JobQueue(2, logger),
			logger,
			metrics: new Metrics(),
			now: () => 60_000,
			originStateTracker: new OriginStateTracker(2, logger),
			scriptRunner,
			statusApiClient: new TestStatusApiClient(
				{
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
					workers: [
						{
							worker: buildDevice({
								deviceId: "alpha-worker",
								origin: "alpha",
							}),
						},
					],
				},
				deletedDeviceIds,
			),
		});

		await monitor.checkAndRunScript();

		expect(deletedDeviceIds).toEqual(["alpha-dead"]);
		expect(scriptRunner.executed).toEqual([]);
	});

	test("counts one offline attempt per origin per poll when duplicate stale devices exist", async () => {
		const deletedDeviceIds: string[] = [];
		const scriptRunner = new TestScriptRunner();
		const originStateTracker = new OriginStateTracker(2, logger);
		const monitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(
				5,
				60_000,
				logger,
				() => 15 * 60 * 1_000,
			),
			configProvider: createConfigProvider(config),
			jobQueue: new JobQueue(2, logger),
			logger,
			metrics: new Metrics(),
			now: () => 15 * 60 * 1_000,
			originStateTracker,
			scriptRunner,
			statusApiClient: new TestStatusApiClient(
				{
					devices: [
						buildDevice({
							deviceId: "alpha-stale-1",
							dateLastMessageReceived: 0,
							isAlive: false,
						}),
						buildDevice({
							deviceId: "alpha-stale-2",
							dateLastMessageReceived: 60_000,
							isAlive: false,
						}),
					],
					workers: [
						{
							worker: buildDevice({
								deviceId: "alpha-worker",
								origin: "alpha",
							}),
						},
					],
				},
				deletedDeviceIds,
			),
		});

		await monitor.checkAndRunScript();

		expect(deletedDeviceIds).toEqual([]);
		expect(scriptRunner.executed).toEqual([
			{
				origin: "alpha",
				scriptMode: "restart",
			},
		]);
		expect(originStateTracker.getState("alpha")).toEqual({
			lastSeen: 15 * 60 * 1_000,
			successiveOfflineCount: 1,
		});
	});

	test("skips polls while the circuit breaker is open", async () => {
		const deletedDeviceIds: string[] = [];
		const statusApiClient = new TestStatusApiClient(
			{
				devices: [],
				workers: [],
			},
			deletedDeviceIds,
		);
		const circuitBreaker = new CircuitBreaker(1, 60_000, logger, () => 0);
		circuitBreaker.recordFailure();
		const monitor = new DeviceMonitor({
			circuitBreaker,
			configProvider: createConfigProvider(config),
			jobQueue: new JobQueue(2, logger),
			logger,
			metrics: new Metrics(),
			now: () => 0,
			originStateTracker: new OriginStateTracker(2, logger),
			scriptRunner: new TestScriptRunner(),
			statusApiClient,
		});

		await monitor.checkAndRunScript();

		expect(statusApiClient.fetchCalls).toBe(0);
		expect(deletedDeviceIds).toEqual([]);
	});

	test("does not allow overlapping polls", async () => {
		let releaseFetch: (() => void) | undefined;
		const statusApiClient = new TestStatusApiClient(
			{
				devices: [],
				workers: [],
			},
			[],
		);
		statusApiClient.fetchStatus = async () => {
			statusApiClient.fetchCalls++;
			await new Promise<void>((resolve) => {
				releaseFetch = resolve;
			});
			return {
				devices: [],
				workers: [],
			};
		};

		const monitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(5, 60_000, logger, () => 0),
			configProvider: createConfigProvider(config),
			jobQueue: new JobQueue(2, logger),
			logger,
			metrics: new Metrics(),
			now: () => 0,
			originStateTracker: new OriginStateTracker(2, logger),
			scriptRunner: new TestScriptRunner(),
			statusApiClient,
		});

		const firstPoll = monitor.checkAndRunScript();
		const secondPoll = monitor.checkAndRunScript();

		expect(statusApiClient.fetchCalls).toBe(1);

		releaseFetch?.();
		await Promise.all([firstPoll, secondPoll]);
	});

	test("ignores duplicate start calls", () => {
		const scheduledCallbacks: Array<() => void> = [];

		globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
			scheduledCallbacks.push(callback as () => void);
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

		const monitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(5, 60_000, logger, () => 0),
			configProvider: createConfigProvider(config),
			jobQueue: new JobQueue(2, logger),
			logger,
			metrics: new Metrics(),
			now: () => 0,
			originStateTracker: new OriginStateTracker(2, logger),
			scriptRunner: new TestScriptRunner(),
			statusApiClient: new TestStatusApiClient(
				{
					devices: [],
					workers: [],
				},
				[],
			),
		});

		monitor.start();
		monitor.start();

		expect(scheduledCallbacks).toHaveLength(1);
	});
});

const createConfigProvider = (nextConfig: Config): ConfigProvider => ({
	getConfig: () => nextConfig,
});
