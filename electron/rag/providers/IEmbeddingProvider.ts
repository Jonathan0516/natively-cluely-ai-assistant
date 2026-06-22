/** Optional context for an embedding call. `meetingId` attributes the usage (and its credits)
 *  to a meeting in the backend metering, so embedding cost shows in per-meeting Usage Details.
 *  Ignored by the on-device local provider (no metering). */
export interface EmbedOpts {
  meetingId?: string | null;
}

export interface IEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  isAvailable(): Promise<boolean>;
  /** Embed a document chunk (for storage) */
  embed(text: string, opts?: EmbedOpts): Promise<number[]>;
  /** Embed a search query (asymmetric models may prepend a search prefix) */
  embedQuery(text: string, opts?: EmbedOpts): Promise<number[]>;
  embedBatch(texts: string[], opts?: EmbedOpts): Promise<number[][]>;
}
