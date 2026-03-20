import { watch } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "@iarna/toml";

export interface ConfigWatcherLike {
	close(): void;
}

const defaultConfigPath = path.resolve(process.cwd(), "config.toml");

export const resolveConfigPath = (
	env: Record<string, string | undefined> = process.env,
): string => path.resolve(env.ROTOM_CONFIG_PATH ?? defaultConfigPath);

export const createConfigWatchHandler = (
	configPath: string,
	onChange: () => void,
): ((eventType: string, fileName: string | null) => void) => {
	const configFileName = path.basename(configPath);

	return (_eventType, fileName) => {
		if (!fileName || fileName.toString() === configFileName) {
			onChange();
		}
	};
};

export const defaultWatchImplementation = (
	configPath: string,
	onChange: () => void,
): ConfigWatcherLike => {
	const configDirectory = path.dirname(configPath);
	const watcher = watch(
		configDirectory,
		createConfigWatchHandler(configPath, onChange),
	);

	return {
		close: () => watcher.close(),
	};
};

export const loadTomlConfig = (
	configPath: string,
	readFileImplementation: (
		filePath: string,
		encoding: BufferEncoding,
	) => string,
): unknown => {
	try {
		return parseToml(readFileImplementation(configPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load TOML config at ${configPath}: ${message}`);
	}
};
