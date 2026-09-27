/** Body of every non-2xx API response. */
export interface ApiErrorBody {
  error: string;
  message: string;
}
