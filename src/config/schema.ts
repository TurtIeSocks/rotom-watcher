import path from "node:path";

import { z } from "zod";

export interface Config {
	checkIntervalMs: number;
	circuitBreakerResetMs: number;
	circuitBreakerThreshold: number;
	deviceTimeoutMinutes: number;
	fetchTimeoutMs: number;
	initialRetryDelayMs: number;
	logFormat: "json" | "pretty";
	logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
	maxConcurrentJobs: number;
	maxRetries: number;
	maxRetryDelayMs: number;
	metricsHost: string;
	metricsPort: number;
	restartThreshold: number;
	rotomApiBaseUrl: string;
	scriptPath: string;
	scriptRestart: string;
	scriptTimeoutMs: number;
	scriptUpdate: string;
	shutdownGracePeriodMs: number;
}

export interface ConfigProvider {
	getConfig(): Config;
}

export interface CreateConfigOptions {
	env?: Record<string, string | undefined>;
	fileConfig?: unknown;
}

const defaultScriptPath = path.resolve(import.meta.dir, "../../oci.sh");

const fileConfigMappings = [
	{
		envKey: "CHECK_INTERVAL_MS",
		path: ["polling", "check_interval_ms"],
	},
	{
		envKey: "DEVICE_TIMEOUT_MINUTES",
		path: ["polling", "device_timeout_minutes"],
	},
	{
		envKey: "ROTOM_API_BASE_URL",
		path: ["rotom_api", "base_url"],
	},
	{
		envKey: "FETCH_TIMEOUT_MS",
		path: ["rotom_api", "fetch_timeout_ms"],
	},
	{
		envKey: "INITIAL_RETRY_DELAY_MS",
		path: ["retry", "initial_delay_ms"],
	},
	{
		envKey: "MAX_RETRY_DELAY_MS",
		path: ["retry", "max_delay_ms"],
	},
	{
		envKey: "MAX_RETRIES",
		path: ["retry", "max_retries"],
	},
	{
		envKey: "MAX_CONCURRENT_JOBS",
		path: ["concurrency", "max_concurrent_jobs"],
	},
	{
		envKey: "CIRCUIT_BREAKER_THRESHOLD",
		path: ["circuit_breaker", "threshold"],
	},
	{
		envKey: "CIRCUIT_BREAKER_RESET_MS",
		path: ["circuit_breaker", "reset_ms"],
	},
	{
		envKey: "SCRIPT_PATH",
		path: ["scripts", "path"],
	},
	{
		envKey: "SCRIPT_RESTART_ARG",
		path: ["scripts", "restart_arg"],
	},
	{
		envKey: "SCRIPT_UPDATE_ARG",
		path: ["scripts", "update_arg"],
	},
	{
		envKey: "SCRIPT_TIMEOUT_MS",
		path: ["scripts", "timeout_ms"],
	},
	{
		envKey: "RESTART_THRESHOLD",
		path: ["scripts", "restart_threshold"],
	},
	{
		envKey: "LOG_LEVEL",
		path: ["logging", "level"],
	},
	{
		envKey: "LOG_FORMAT",
		path: ["logging", "format"],
	},
	{
		envKey: "METRICS_HOST",
		path: ["metrics", "host"],
	},
	{
		envKey: "METRICS_PORT",
		path: ["metrics", "port"],
	},
	{
		envKey: "SHUTDOWN_GRACE_PERIOD_MS",
		path: ["shutdown", "grace_period_ms"],
	},
] as const;

const positiveInteger = (name: string, defaultValue: number) =>
	z.preprocess(
		(value) => value ?? defaultValue,
		z.coerce
			.number({
				error: `${name} must be a valid number`,
			})
			.int(`${name} must be an integer`)
			.positive(`${name} must be greater than 0`),
	);

const positiveIntegerWithMinimum = (
	name: string,
	defaultValue: number,
	minimum: number,
) =>
	z.preprocess(
		(value) => value ?? defaultValue,
		z.coerce
			.number({
				error: `${name} must be a valid number`,
			})
			.int(`${name} must be an integer`)
			.gte(minimum, `${name} must be at least ${minimum}`),
	);

const configSchema = z
	.object({
		CHECK_INTERVAL_MS: positiveInteger("CHECK_INTERVAL_MS", 300_000),
		CIRCUIT_BREAKER_RESET_MS: positiveInteger(
			"CIRCUIT_BREAKER_RESET_MS",
			60_000,
		),
		CIRCUIT_BREAKER_THRESHOLD: positiveInteger("CIRCUIT_BREAKER_THRESHOLD", 5),
		DEVICE_TIMEOUT_MINUTES: positiveInteger("DEVICE_TIMEOUT_MINUTES", 10),
		FETCH_TIMEOUT_MS: positiveInteger("FETCH_TIMEOUT_MS", 30_000),
		INITIAL_RETRY_DELAY_MS: positiveInteger("INITIAL_RETRY_DELAY_MS", 1_000),
		LOG_FORMAT: z
			.string()
			.optional()
			.transform((value) => value?.toLowerCase() ?? "json")
			.pipe(z.enum(["json", "pretty"])),
		LOG_LEVEL: z
			.string()
			.optional()
			.transform((value) => value?.toLowerCase() ?? "info")
			.pipe(z.enum(["fatal", "error", "warn", "info", "debug", "trace"])),
		MAX_CONCURRENT_JOBS: positiveInteger("MAX_CONCURRENT_JOBS", 10),
		MAX_RETRIES: positiveIntegerWithMinimum("MAX_RETRIES", 3, 0),
		MAX_RETRY_DELAY_MS: positiveInteger("MAX_RETRY_DELAY_MS", 30_000),
		METRICS_HOST: z.preprocess(
			(value) => value ?? "127.0.0.1",
			z.string().min(1, "METRICS_HOST must not be empty"),
		),
		METRICS_PORT: z.preprocess(
			(value) => value ?? 9_090,
			z.coerce
				.number({
					error: "METRICS_PORT must be a valid number",
				})
				.int("METRICS_PORT must be an integer")
				.min(1, "METRICS_PORT must be between 1 and 65535")
				.max(65_535, "METRICS_PORT must be between 1 and 65535"),
		),
		RESTART_THRESHOLD: positiveInteger("RESTART_THRESHOLD", 2),
		ROTOM_API_BASE_URL: z
			.string({
				error: "ROTOM_API_BASE_URL is required",
			})
			.min(1, "ROTOM_API_BASE_URL is required")
			.url("ROTOM_API_BASE_URL must be a valid URL")
			.refine((value) => {
				const url = new URL(value);
				return url.protocol === "http:" || url.protocol === "https:";
			}, "ROTOM_API_BASE_URL must use http or https"),
		SCRIPT_PATH: z.preprocess(
			(value) => value ?? defaultScriptPath,
			z.string().min(1, "SCRIPT_PATH must not be empty"),
		),
		SCRIPT_RESTART_ARG: z.preprocess(
			(value) => value ?? "-rsc",
			z.string().min(1, "SCRIPT_RESTART_ARG must not be empty"),
		),
		SCRIPT_TIMEOUT_MS: positiveInteger("SCRIPT_TIMEOUT_MS", 300_000),
		SCRIPT_UPDATE_ARG: z.preprocess(
			(value) => value ?? "-usc",
			z.string().min(1, "SCRIPT_UPDATE_ARG must not be empty"),
		),
		SHUTDOWN_GRACE_PERIOD_MS: positiveInteger(
			"SHUTDOWN_GRACE_PERIOD_MS",
			60_000,
		),
	})
	.transform(
		(values): Config => ({
			checkIntervalMs: values.CHECK_INTERVAL_MS,
			circuitBreakerResetMs: values.CIRCUIT_BREAKER_RESET_MS,
			circuitBreakerThreshold: values.CIRCUIT_BREAKER_THRESHOLD,
			deviceTimeoutMinutes: values.DEVICE_TIMEOUT_MINUTES,
			fetchTimeoutMs: values.FETCH_TIMEOUT_MS,
			initialRetryDelayMs: values.INITIAL_RETRY_DELAY_MS,
			logFormat: values.LOG_FORMAT,
			logLevel: values.LOG_LEVEL,
			maxConcurrentJobs: values.MAX_CONCURRENT_JOBS,
			maxRetries: values.MAX_RETRIES,
			maxRetryDelayMs: values.MAX_RETRY_DELAY_MS,
			metricsHost: values.METRICS_HOST,
			metricsPort: values.METRICS_PORT,
			restartThreshold: values.RESTART_THRESHOLD,
			rotomApiBaseUrl: new URL(values.ROTOM_API_BASE_URL).toString(),
			scriptPath: path.resolve(values.SCRIPT_PATH),
			scriptRestart: values.SCRIPT_RESTART_ARG,
			scriptTimeoutMs: values.SCRIPT_TIMEOUT_MS,
			scriptUpdate: values.SCRIPT_UPDATE_ARG,
			shutdownGracePeriodMs: values.SHUTDOWN_GRACE_PERIOD_MS,
		}),
	);

export const createConfig = ({
	env = process.env,
	fileConfig,
}: CreateConfigOptions = {}): Config => {
	const mergedInputs = {
		...flattenFileConfig(fileConfig),
		...removeUndefinedEntries(env),
	};

	return configSchema.parse(mergedInputs);
};

const flattenFileConfig = (fileConfig: unknown): Record<string, unknown> => {
	const flattened: Record<string, unknown> = {};

	for (const mapping of fileConfigMappings) {
		const value = getNestedValue(fileConfig, mapping.path);
		if (value !== undefined) {
			flattened[mapping.envKey] = value;
		}
	}

	return flattened;
};

const getNestedValue = (
	source: unknown,
	pathSegments: readonly string[],
): unknown => {
	let current: unknown = source;

	for (const segment of pathSegments) {
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			return undefined;
		}

		current = (current as Record<string, unknown>)[segment];
	}

	return current;
};

const removeUndefinedEntries = (
	values: Record<string, string | undefined>,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, string] => {
			const [, value] = entry;
			return value !== undefined;
		}),
	);
