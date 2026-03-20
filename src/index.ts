import { CircuitBreaker } from "./circuit-breaker";
import { ConfigManager, resolveConfigPath } from "./config";
import { DeviceMonitor } from "./device-monitor";
import { JobQueue } from "./job-queue";
import { createLogger } from "./logger";
import { Metrics } from "./metrics";
import { ObservabilityServer } from "./observability-server";
import { OriginStateTracker } from "./origin-state";
import { RotomApiClient } from "./rotom-api";
import { ScriptRunner } from "./script-runner";

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
