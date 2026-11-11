// Optional content-side typing supplied by the platform, not an SDK import.
export {};

declare global {
  interface Window {
    readonly game: {
      echo(input: { value: string }, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ value: string }>;
    };
  }
}
