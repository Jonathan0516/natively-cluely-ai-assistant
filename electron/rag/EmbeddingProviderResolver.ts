import { IEmbeddingProvider } from './providers/IEmbeddingProvider';
import { CloudEmbeddingProvider } from './providers/CloudEmbeddingProvider';
import { LocalEmbeddingProvider } from './providers/LocalEmbeddingProvider';

export interface AppAPIConfig {
  openaiKey?: string;
  geminiKey?: string;
  ollamaUrl?: string;
}

export class EmbeddingProviderResolver {
  /**
   * Returns the best available provider.
   * Cloud (backend gateway, platform Gemini key) is preferred when authenticated.
   * Local bundled model is the unconditional offline fallback — always last.
   */
  static async resolve(_config: AppAPIConfig): Promise<IEmbeddingProvider> {
    const candidates: IEmbeddingProvider[] = [
      new CloudEmbeddingProvider(),
      new LocalEmbeddingProvider(), // offline fallback, always works
    ];

    for (const provider of candidates) {
      const available = await provider.isAvailable();
      if (available) {
        console.log(`[EmbeddingProviderResolver] Selected provider: ${provider.name} (${provider.dimensions}d)`);
        return provider;
      }
      console.log(`[EmbeddingProviderResolver] Provider ${provider.name} unavailable, trying next...`);
    }

    throw new Error('No embedding provider available. The bundled model may be corrupted. Please reinstall.');
  }
}
