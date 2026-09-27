/** Response of `GET /api/v1/status`, also used by the Docker healthcheck. */
export interface StatusResponse {
  status: 'ok';
  version: string;
  /** Seconds since the server process started. */
  uptime: number;
}
