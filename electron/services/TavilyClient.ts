import axios, { AxiosError } from 'axios';

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
}

export class TavilyClient {
  private apiKey: string;
  public quotaExhausted: boolean = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Run a single Tavily search.
   * @param query     The search query string
   * @param opts.depth  'basic' (1 credit) or 'advanced' (2 credits, better synthesis)
   * @param opts.maxResults  1–10 (default 5)
   * @param opts.includeAnswer  if true, Tavily LLM-summarizes results
   */
  public async search(
    query: string,
    opts: { depth?: 'basic' | 'advanced'; maxResults?: number; includeAnswer?: boolean } = {}
  ): Promise<TavilySearchResponse> {
    if (this.quotaExhausted) {
      throw new Error('Tavily quota exhausted for this billing period.');
    }
    const body = {
      api_key: this.apiKey,
      query,
      search_depth: opts.depth || 'basic',
      max_results: opts.maxResults ?? 5,
      include_answer: opts.includeAnswer ?? false,
    };

    try {
      const resp = await axios.post('https://api.tavily.com/search', body, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      });
      return {
        query,
        answer: resp.data?.answer,
        results: (resp.data?.results || []) as TavilyResult[],
      };
    } catch (e) {
      const err = e as AxiosError;
      if (err.response?.status === 402 || err.response?.status === 429) {
        this.quotaExhausted = true;
        throw new Error('Tavily quota exhausted. Add credits at tavily.com or wait for the next billing cycle.');
      }
      if (err.response?.status === 401) {
        throw new Error('Tavily API key rejected. Check the key in Settings.');
      }
      const detail = (err.response?.data as any)?.detail || err.message;
      throw new Error(`Tavily search failed: ${detail}`);
    }
  }

  /**
   * Fire several queries in parallel. Failures on individual queries don't
   * abort the rest — they're returned with empty results so the LLM can still
   * synthesize from whatever succeeded.
   */
  public async searchMany(queries: string[], opts: { depth?: 'basic' | 'advanced'; maxResults?: number } = {}): Promise<TavilySearchResponse[]> {
    const settled = await Promise.allSettled(queries.map(q => this.search(q, opts)));
    return settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { query: queries[i], results: [], answer: undefined }
    );
  }
}
