import type { StatusResponse } from "./types";
import { fetchWithTimeout } from "./utils";

export class StatusApiClient {
	constructor(
		private readonly endpoint: string,
		private readonly timeoutMs: number,
	) {}

	async fetchStatus(): Promise<StatusResponse> {
		const response = await fetchWithTimeout(
			`http://${this.endpoint}/api/status`,
			this.timeoutMs,
		);

		if (!response.ok) {
			throw new Error(`HTTP error! Status: ${response.status}`);
		}

		return (await response.json()) as StatusResponse;
	}
}
