import type { StatusResponse } from "./types";
import { fetchWithTimeout } from "./utils";

export class RotomApiClient {
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

	async deleteDevice(deviceId: string): Promise<boolean> {
		const response = await fetchWithTimeout(
			`http://${this.endpoint}/api/device/${deviceId}/action/delete`,
			this.timeoutMs,
		);

		if (!response.ok) {
			return false;
		}

		return true;
	}
}
