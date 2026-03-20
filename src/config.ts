import path from "node:path";

export interface Config {
	checkIntervalMs: number;
	circuitBreakerResetMs: number;
	circuitBreakerThreshold: number;
	deviceTimeoutMinutes: number;
	endpoint: string;
	fetchTimeoutMs: number;
	initialRetryDelayMs: number;
	maxConcurrentJobs: number;
	maxRetries: number;
	maxRetryDelayMs: number;
	restartThreshold: number;
	scriptPath: string;
	scriptRestart: string;
	scriptTimeoutMs: number;
	scriptUpdate: string;
}

const parseIntegerEnv = (name: string, fallback: number): number => {
	const value = process.env[name];
	if (!value) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
};

export const createConfig = (): Config => ({
	checkIntervalMs: parseIntegerEnv("CHECK_INTERVAL_MS", 300_000),
	circuitBreakerResetMs: parseIntegerEnv("CIRCUIT_BREAKER_RESET_MS", 60_000),
	circuitBreakerThreshold: parseIntegerEnv("CIRCUIT_BREAKER_THRESHOLD", 5),
	deviceTimeoutMinutes: parseIntegerEnv("DEVICE_TIMEOUT_MINUTES", 10),
	endpoint: process.env.ENDPOINT || "5.161.111.204:7072",
	fetchTimeoutMs: parseIntegerEnv("FETCH_TIMEOUT_MS", 30_000),
	initialRetryDelayMs: parseIntegerEnv("INITIAL_RETRY_DELAY_MS", 1_000),
	maxConcurrentJobs: parseIntegerEnv("MAX_CONCURRENT_JOBS", 10),
	maxRetries: parseIntegerEnv("MAX_RETRIES", 3),
	maxRetryDelayMs: parseIntegerEnv("MAX_RETRY_DELAY_MS", 30_000),
	restartThreshold: 2,
	scriptPath: path.resolve(import.meta.dir, "../../oci.sh"),
	scriptRestart: "-rsc",
	scriptTimeoutMs: parseIntegerEnv("SCRIPT_TIMEOUT_MS", 300_000),
	scriptUpdate: "-usc",
});
