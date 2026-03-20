import { resolveConfigPath } from "./config/file";
import { ConfigManager } from "./config/manager";
import { DeviceMonitor } from "./monitor/device-monitor";
import { OriginStateTracker } from "./monitor/origin-state";
import { createLogger } from "./observability/logger";
import { Metrics } from "./observability/metrics";
import { ObservabilityServer } from "./observability/server";
import { RotomApiClient } from "./rotom/client";
import { CircuitBreaker } from "./runtime/circuit-breaker";
import { JobQueue } from "./runtime/job-queue";
import { ScriptRunner } from "./runtime/script-runner";

const configManager = new ConfigManager({
	configPath: resolveConfigPath(),
});
const initialConfig = configManager.getConfig();
const logger = createLogger({
	format: initialConfig.logFormat,
	level: initialConfig.logLevel,
});

configManager.setLogger(logger);

const metrics = new Metrics();
const circuitBreaker = new CircuitBreaker(
	initialConfig.circuitBreakerThreshold,
	initialConfig.circuitBreakerResetMs,
	logger,
);
const originStateTracker = new OriginStateTracker(
	initialConfig.restartThreshold,
	logger,
);
const jobQueue = new JobQueue(initialConfig.maxConcurrentJobs, logger, metrics);
const scriptRunner = new ScriptRunner(configManager, logger, metrics);
const statusApiClient = new RotomApiClient(configManager, metrics);
const observabilityServer = new ObservabilityServer(
	initialConfig.metricsHost,
	initialConfig.metricsPort,
	logger,
	metrics,
);

configManager.subscribe(({ changedKeys, config }) => {
	if (changedKeys.includes("logLevel")) {
		logger.setLevel?.(config.logLevel);
	}

	if (
		changedKeys.includes("circuitBreakerThreshold") ||
		changedKeys.includes("circuitBreakerResetMs")
	) {
		circuitBreaker.updateConfig(
			config.circuitBreakerThreshold,
			config.circuitBreakerResetMs,
		);
	}

	if (changedKeys.includes("maxConcurrentJobs")) {
		jobQueue.setConcurrency(config.maxConcurrentJobs);
		metrics.updateQueueStatus(jobQueue.getStatus());
	}

	if (changedKeys.includes("restartThreshold")) {
		originStateTracker.setRestartThreshold(config.restartThreshold);
	}
});

const monitor = new DeviceMonitor({
	circuitBreaker,
	configProvider: configManager,
	jobQueue,
	logger,
	metrics,
	onShutdown: async () => {
		configManager.close();
		observabilityServer.stop();
	},
	originStateTracker,
	scriptRunner,
	statusApiClient,
});

observabilityServer.start();
configManager.startWatching();
monitor.start();
