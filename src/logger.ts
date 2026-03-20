import pino from "pino";

export type LogLevelName =
	| "fatal"
	| "error"
	| "warn"
	| "info"
	| "debug"
	| "trace";

export interface LoggerLike {
	debug(...args: unknown[]): void;
	error(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
}

export interface CreateLoggerOptions {
	format: "json" | "pretty";
	level: LogLevelName;
}

export const createLogger = ({
	format,
	level,
}: CreateLoggerOptions): LoggerLike =>
	pino({
		level,
		name: "rotom-watcher",
		transport:
			format === "pretty"
				? {
						options: {
							colorize: true,
							ignore: "pid,hostname",
							translateTime: "SYS:standard",
						},
						target: "pino-pretty",
					}
				: undefined,
	});
