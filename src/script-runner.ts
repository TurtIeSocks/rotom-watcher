import { exec } from "node:child_process";

import type { Config } from "./config";
import type { LoggerLike } from "./logger";
import type { Metrics } from "./metrics";
import { calculateRetryDelay, sanitizeOrigin, sleep } from "./utils";

export class ScriptRunner {
	constructor(
		private readonly config: Config,
		private readonly logger: LoggerLike,
		private readonly metrics: Metrics,
		private readonly sleepFn: typeof sleep = sleep,
	) {}

	async execute(origin: string, args: string, attempt = 0): Promise<void> {
		const sanitized = sanitizeOrigin(origin);

		if (sanitized !== origin) {
			this.logger.warn(`Origin sanitized from "${origin}" to "${sanitized}"`);
		}

		const startTime = Date.now();

		return new Promise((resolve, reject) => {
			const command = `bash ${this.config.scriptPath} ${args} "${sanitized}"`;
			this.logger.info(
				`[${sanitized}] Executing script: ${args} (attempt ${attempt + 1}/${this.config.maxRetries + 1})`,
			);

			const child = exec(
				command,
				{ timeout: this.config.scriptTimeoutMs },
				(error, stdout, stderr) => {
					const duration = Date.now() - startTime;

					if (error) {
						this.logger.error(
							`[${sanitized}] Script failed after ${duration}ms:`,
							error.message,
						);

						if (stderr) {
							this.logger.error(`[${sanitized}] stderr:`, stderr.trim());
						}

						this.metrics.recordScriptFailure(duration);

						if (attempt < this.config.maxRetries) {
							const delay = calculateRetryDelay(
								attempt,
								this.config.initialRetryDelayMs,
								this.config.maxRetryDelayMs,
							);
							this.logger.info(`[${sanitized}] Retrying in ${delay}ms...`);

							void this.sleepFn(delay)
								.then(() => this.execute(origin, args, attempt + 1))
								.then(resolve)
								.catch(reject);
						} else {
							reject(error);
						}

						return;
					}

					if (stderr) {
						this.logger.warn(`[${sanitized}] stderr:`, stderr.trim());
					}

					if (stdout) {
						this.logger.info(`[${sanitized}] stdout:`, stdout.trim());
					}

					this.logger.info(
						`[${sanitized}] Script completed successfully in ${duration}ms`,
					);
					this.metrics.recordScriptSuccess(duration);
					resolve();
				},
			);

			child.on("exit", (_code, signal) => {
				if (signal === "SIGTERM") {
					this.logger.warn(
						`[${sanitized}] Script timed out after ${this.config.scriptTimeoutMs}ms`,
					);
				}
			});
		});
	}
}
