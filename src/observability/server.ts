import type { LoggerLike } from "./logger";
import type { Metrics } from "./metrics";

export class ObservabilityServer {
	private server?: ReturnType<typeof Bun.serve>;

	constructor(
		private readonly host: string,
		private readonly port: number,
		private readonly logger: LoggerLike,
		private readonly metrics: Metrics,
	) {}

	handleRequest = async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);

		if (pathname === "/metrics") {
			return new Response(await this.metrics.render(), {
				headers: {
					"content-type": this.metrics.getContentType(),
				},
				status: 200,
			});
		}

		if (pathname === "/healthz" || pathname === "/readyz") {
			const snapshot = this.metrics.getHealthSnapshot();
			const isReadyRoute = pathname === "/readyz";
			const ok = isReadyRoute ? snapshot.ready : snapshot.healthy;

			return Response.json(snapshot, {
				status: ok ? 200 : 503,
			});
		}

		return Response.json(
			{
				error: "Not found",
			},
			{
				status: 404,
			},
		);
	};

	start(): void {
		if (this.server) {
			return;
		}

		this.server = Bun.serve({
			development: false,
			error: (error) => {
				this.logger.error({ error }, "Observability server error");
				return Response.json(
					{
						error: "Internal server error",
					},
					{
						status: 500,
					},
				);
			},
			fetch: this.handleRequest,
			hostname: this.host,
			port: this.port,
		});

		this.logger.info(
			{
				host: this.host,
				port: this.server.port,
			},
			"Observability server listening",
		);
	}

	stop(): void {
		if (!this.server) {
			return;
		}

		this.server.stop(true);
		this.server = undefined;
	}
}
