import { readFileSync } from "node:fs";

import type { LoggerLike } from "../observability/logger";
import {
	type ConfigWatcherLike,
	defaultWatchImplementation,
	loadTomlConfig,
} from "./file";
import { type Config, type ConfigProvider, createConfig } from "./schema";

export interface ConfigReloadEvent {
	changedKeys: Array<keyof Config>;
	config: Config;
	restartRequiredKeys: Array<keyof Config>;
}

export interface ConfigManagerOptions {
	cancelScheduledReload?: (handle: unknown) => void;
	configPath: string;
	env?: Record<string, string | undefined>;
	logger?: LoggerLike;
	readFileImplementation?: (
		filePath: string,
		encoding: BufferEncoding,
	) => string;
	scheduleReload?: (reload: () => void) => unknown;
	watchImplementation?: (
		configPath: string,
		onChange: () => void,
	) => ConfigWatcherLike;
}

type ConfigChangeListener = (event: ConfigReloadEvent) => void;

const watchDebounceMs = 100;

const restartRequiredConfigKeys: Array<keyof Config> = [
	"logFormat",
	"metricsHost",
	"metricsPort",
];

export class ConfigManager implements ConfigProvider {
	private currentConfig: Config;
	private logger?: LoggerLike;
	private scheduledReloadHandle?: unknown;
	private readonly listeners = new Set<ConfigChangeListener>();
	private watcher?: ConfigWatcherLike;

	constructor(private readonly options: ConfigManagerOptions) {
		this.logger = options.logger;
		this.currentConfig = this.readValidatedConfig();
	}

	close(): void {
		if (this.scheduledReloadHandle !== undefined) {
			this.getCancelScheduledReload()(this.scheduledReloadHandle);
			this.scheduledReloadHandle = undefined;
		}

		this.watcher?.close();
		this.watcher = undefined;
	}

	getConfig(): Config {
		return this.currentConfig;
	}

	reloadFromDisk(trigger: "manual" | "watch" = "manual"): boolean {
		try {
			const nextConfig = this.readValidatedConfig();
			const changedKeys = getChangedConfigKeys(this.currentConfig, nextConfig);

			if (changedKeys.length === 0) {
				this.logger?.debug(
					{
						configPath: this.options.configPath,
						trigger,
					},
					"Config reload found no changes",
				);
				return true;
			}

			this.currentConfig = nextConfig;
			const restartRequiredKeys = changedKeys.filter((key) =>
				restartRequiredConfigKeys.includes(key),
			);

			this.logger?.info(
				{
					changedKeys,
					configPath: this.options.configPath,
					trigger,
				},
				"Reloaded configuration from TOML",
			);

			if (restartRequiredKeys.length > 0) {
				this.logger?.warn(
					{
						restartRequiredKeys,
					},
					"Some config changes require a process restart to fully apply",
				);
			}

			const event: ConfigReloadEvent = {
				changedKeys,
				config: nextConfig,
				restartRequiredKeys,
			};

			for (const listener of this.listeners) {
				listener(event);
			}

			return true;
		} catch (error) {
			this.logger?.error(
				{
					configPath: this.options.configPath,
					error,
					trigger,
				},
				"Rejected invalid configuration reload and kept the last known good config",
			);
			return false;
		}
	}

	setLogger(logger: LoggerLike): void {
		this.logger = logger;
	}

	startWatching(): void {
		if (this.watcher) {
			return;
		}

		this.watcher = this.getWatchImplementation()(
			this.options.configPath,
			() => {
				if (this.scheduledReloadHandle !== undefined) {
					this.getCancelScheduledReload()(this.scheduledReloadHandle);
				}

				this.scheduledReloadHandle = this.getScheduleReload()(() => {
					this.scheduledReloadHandle = undefined;
					this.reloadFromDisk("watch");
				});
			},
		);
	}

	subscribe(listener: ConfigChangeListener): () => void {
		this.listeners.add(listener);

		return () => {
			this.listeners.delete(listener);
		};
	}

	private getCancelScheduledReload(): (handle: unknown) => void {
		return (
			this.options.cancelScheduledReload ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
		);
	}

	private getReadFileImplementation(): (
		filePath: string,
		encoding: BufferEncoding,
	) => string {
		return this.options.readFileImplementation ?? readFileSync;
	}

	private getScheduleReload(): (reload: () => void) => unknown {
		return (
			this.options.scheduleReload ??
			((reload) => setTimeout(reload, watchDebounceMs))
		);
	}

	private getWatchImplementation(): (
		configPath: string,
		onChange: () => void,
	) => ConfigWatcherLike {
		return this.options.watchImplementation ?? defaultWatchImplementation;
	}

	private readValidatedConfig(): Config {
		const fileConfig = loadTomlConfig(
			this.options.configPath,
			this.getReadFileImplementation(),
		);

		return createConfig({
			env: this.options.env ?? process.env,
			fileConfig,
		});
	}
}

const serializeConfigValue = (value: unknown): string =>
	JSON.stringify(value, (_key, val) =>
		val instanceof Set ? [...val].sort() : val,
	);

const getChangedConfigKeys = (
	previousConfig: Config,
	nextConfig: Config,
): Array<keyof Config> =>
	(Object.keys(previousConfig) as Array<keyof Config>).filter(
		(key) =>
			serializeConfigValue(previousConfig[key]) !==
			serializeConfigValue(nextConfig[key]),
	);
