import { afterEach, describe, expect, test } from "bun:test";
import type { Config, ConfigProvider } from "../config/schema";
import type { LoggerLike } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import { RotomApiClient } from "../rotom/client";
import type { Device, StatusResponse, Worker } from "../rotom/types";
import { CircuitBreaker } from "../runtime/circuit-breaker";
import { JobQueue } from "../runtime/job-queue";
import { ScriptRunner } from "../runtime/script-runner";
import { DeviceMonitor } from "./device-monitor";
import { OriginStateTracker } from "./origin-state";
import type { ScriptMode } from "./types";

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
const originalProcessOnce = process.once;

const createCapturingLogger = (errorLogs: unknown[]): LoggerLike => ({
	debug: () => undefined,
	error: (...args: unknown[]) => {
		errorLogs.push(args);
	},
	info: () => undefined,
	warn: () => undefined,
});

afterEach(() => {
	globalThis.setTimeout = originalSetTimeout;
	globalThis.clearTimeout = originalClearTimeout;
	process.once = originalProcessOnce;
	process.exitCode = undefined;
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
					workers: [buildWorker("alpha")],
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
					workers: [buildWorker("alpha")],
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

	test("logs queue failures and poll failures", async () => {
		const errorLogs: unknown[] = [];
		const capturingLogger = createCapturingLogger(errorLogs);
		const explodingQueue = {
			add: async () => {
				throw new Error("queue exploded");
			},
			getStatus: () => ({
				activeOrigins: [],
				capacity: 2,
				duplicateRejectedTotal: 0,
				queued: 0,
				running: 0,
				saturated: false,
			}),
		} as unknown as JobQueue;
		const offlineMonitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(5, 60_000, capturingLogger, () => 0),
			configProvider: createConfigProvider(config),
			jobQueue: explodingQueue,
			logger: capturingLogger,
			metrics: new Metrics(),
			now: () => 15 * 60 * 1_000,
			originStateTracker: new OriginStateTracker(2, capturingLogger),
			scriptRunner: new TestScriptRunner(),
			statusApiClient: new TestStatusApiClient(
				{
					devices: [
						buildDevice({
							deviceId: "alpha-stale-1",
							dateLastMessageReceived: 0,
							isAlive: false,
						}),
					],
					workers: [],
				},
				[],
			),
		});

		await offlineMonitor.checkAndRunScript();

		const failingStatusClient = new TestStatusApiClient(
			{
				devices: [],
				workers: [],
			},
			[],
		);
		failingStatusClient.fetchStatus = async () => {
			throw new Error("boom");
		};

		const failingMonitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(5, 60_000, capturingLogger, () => 0),
			configProvider: createConfigProvider(config),
			jobQueue: new JobQueue(2, capturingLogger),
			logger: capturingLogger,
			metrics: new Metrics(),
			now: () => 0,
			originStateTracker: new OriginStateTracker(2, capturingLogger),
			scriptRunner: new TestScriptRunner(),
			statusApiClient: failingStatusClient,
		});

		await failingMonitor.checkAndRunScript();

		expect(errorLogs.length).toBeGreaterThan(1);
	});

	test("stop is idempotent and executes the shutdown hook once", async () => {
		let shutdownCalls = 0;
		const monitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(5, 60_000, logger, () => 0),
			configProvider: createConfigProvider(config),
			jobQueue: new JobQueue(2, logger),
			logger,
			metrics: new Metrics(),
			onShutdown: async () => {
				shutdownCalls++;
			},
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

		const stopOne = monitor.stop("manual", 0);
		const stopTwo = monitor.stop("manual", 0);

		expect(stopOne).toBe(stopTwo);
		await stopOne;
		expect(shutdownCalls).toBe(1);
	});

	test("registers signal handlers and routes them through stop", async () => {
		const errorLogs: unknown[] = [];
		const capturingLogger = createCapturingLogger(errorLogs);
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const scheduledCallbacks: Array<() => void> = [];

		globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
			scheduledCallbacks.push(callback as () => void);
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
		process.once = ((event: string, handler: (...args: unknown[]) => void) => {
			handlers.set(event, handler);
			return process;
		}) as typeof process.once;

		const monitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(5, 60_000, capturingLogger, () => 0),
			configProvider: createConfigProvider(config),
			jobQueue: new JobQueue(2, capturingLogger),
			logger: capturingLogger,
			metrics: new Metrics(),
			now: () => 0,
			originStateTracker: new OriginStateTracker(2, capturingLogger),
			scriptRunner: new TestScriptRunner(),
			statusApiClient: new TestStatusApiClient(
				{
					devices: [],
					workers: [],
				},
				[],
			),
		});

		const stopCalls: Array<{ exitCode: number; signal: string }> = [];
		(
			monitor as { stop: (signal: string, exitCode: number) => Promise<void> }
		).stop = async (signal: string, exitCode: number) => {
			stopCalls.push({
				exitCode,
				signal,
			});
		};
		(
			monitor as unknown as { runScheduledCheck: () => Promise<void> }
		).runScheduledCheck = async () => undefined;

		monitor.start();
		scheduledCallbacks[0]?.();
		handlers.get("SIGINT")?.();
		handlers.get("SIGTERM")?.();
		handlers.get("uncaughtException")?.(new Error("uncaught"));
		handlers.get("unhandledRejection")?.("nope");

		expect(stopCalls).toEqual([
			{
				exitCode: 0,
				signal: "SIGINT",
			},
			{
				exitCode: 0,
				signal: "SIGTERM",
			},
			{
				exitCode: 1,
				signal: "uncaughtException",
			},
			{
				exitCode: 1,
				signal: "unhandledRejection",
			},
		]);
		expect(errorLogs.length).toBe(2);
	});

	test("reschedules after a scheduled check when not shutting down", async () => {
		const scheduledDelays: number[] = [];
		const monitor = new DeviceMonitor({
			circuitBreaker: new CircuitBreaker(5, 60_000, logger, () => 0),
			configProvider: createConfigProvider({
				...config,
				checkIntervalMs: 12_345,
			}),
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

		(
			monitor as unknown as { checkAndRunScript: () => Promise<void> }
		).checkAndRunScript = async () => undefined;
		(
			monitor as unknown as { scheduleNextCheck: (delayMs: number) => void }
		).scheduleNextCheck = (delayMs: number) => {
			scheduledDelays.push(delayMs);
		};

		await (
			monitor as unknown as { runScheduledCheck: () => Promise<void> }
		).runScheduledCheck();

		expect(scheduledDelays).toEqual([12_345]);
	});
});

const createConfigProvider = (nextConfig: Config): ConfigProvider => ({
	getConfig: () => nextConfig,
});
