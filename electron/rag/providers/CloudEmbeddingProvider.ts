import { EmbedOpts, IEmbeddingProvider } from './IEmbeddingProvider';
import { CloudClient } from '../../services/CloudClient';

/**
 * Computes embeddings via the backend /llm/embeddings gateway (platform Gemini key).
 * Selected first whenever the user is authenticated; replaces the old local OpenAI/
 * Gemini/Ollama providers.
 */
export class CloudEmbeddingProvider implements IEmbeddingProvider {
  readonly name = 'cloud';
  readonly dimensions = 768; // backend embed-default = gemini-embedding-001 @ 768d

  async isAvailable(): Promise<boolean> {
    try {
      return CloudClient.getInstance().isAuthenticated();
    } catch {
      return false;
    }
  }

  async embed(text: string, opts?: EmbedOpts): Promise<number[]> {
    const out = await this.embedBatch([text], opts);
    return out[0];
  }

  async embedQuery(text: string, opts?: EmbedOpts): Promise<number[]> {
    return this.embed(text, opts);
  }

  async embedBatch(texts: string[], opts?: EmbedOpts): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await CloudClient.getInstance().llmEmbeddings(texts, undefined, opts?.meetingId);
    return res.embeddings;
  }
}
