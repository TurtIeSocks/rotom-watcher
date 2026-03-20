const LOG_LEVELS = {
	DEBUG: 3,
	ERROR: 0,
	INFO: 2,
	WARN: 1,
} as const;

export type LogLevelName = keyof typeof LOG_LEVELS;

export interface LoggerLike {
	debug(...args: unknown[]): void;
	error(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
}

export class Logger implements LoggerLike {
	private readonly level: number;

	constructor(level: LogLevelName | string = "INFO") {
		this.level =
			level in LOG_LEVELS ? LOG_LEVELS[level as LogLevelName] : LOG_LEVELS.INFO;
	}

	debug(...args: unknown[]): void {
		this.log(LOG_LEVELS.DEBUG, "DEBUG", ...args);
	}

	error(...args: unknown[]): void {
		this.log(LOG_LEVELS.ERROR, "ERROR", ...args);
	}

	info(...args: unknown[]): void {
		this.log(LOG_LEVELS.INFO, "INFO", ...args);
	}

	warn(...args: unknown[]): void {
		this.log(LOG_LEVELS.WARN, "WARN", ...args);
	}

	private log(
		level: number,
		levelName: LogLevelName,
		...args: unknown[]
	): void {
		if (this.level >= level) {
			console.log(`[${new Date().toISOString()}] [${levelName}]`, ...args);
		}
	}
}
