import { IEmbeddingProvider } from './IEmbeddingProvider';
import { CloudClient } from '../../services/CloudClient';

/**
 * Computes embeddings via the backend /llm/embeddings gateway (platform Gemini key).
 * Selected first whenever the user is authenticated; replaces the old local OpenAI/
 * Gemini/Ollama providers.
 */
export class CloudEmbeddingProvider implements IEmbeddingProvider {
  readonly name = 'cloud';
  readonly dimensions = 768; // text-embedding-004 @ 768d

  async isAvailable(): Promise<boolean> {
    try {
      return CloudClient.getInstance().isAuthenticated();
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const out = await this.embedBatch([text]);
    return out[0];
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await CloudClient.getInstance().llmEmbeddings(texts);
    return res.embeddings;
  }
}
