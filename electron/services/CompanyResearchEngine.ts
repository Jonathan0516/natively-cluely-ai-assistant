import { TavilyClient, TavilySearchResponse } from './TavilyClient';

export interface JDContext {
  title?: string;
  location?: string;
  level?: string;
  technologies?: string[];
  requirements?: string[];
  keywords?: string[];
  compensation_hint?: string;
  min_years_experience?: number;
}

export interface SalaryEstimate {
  title: string;
  location: string;
  min: number;
  max: number;
  currency: string;
  source: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface CultureRatings {
  overall: number;
  work_life_balance: number;
  career_growth: number;
  compensation: number;
  management: number;
  diversity: number;
  review_count?: string;
  data_sources: string[];
}

export interface EmployeeReview {
  quote: string;
  sentiment: 'positive' | 'mixed' | 'negative';
  source: string;
  role?: string;
}

export interface CriticInsight {
  category: string;
  complaint: string;
  frequency: 'occasionally' | 'frequently' | 'widespread';
}

export interface CompanyDossier {
  company: string;
  hiring_strategy: string;
  interview_focus: string;
  interview_difficulty: 'easy' | 'medium' | 'hard' | 'very_hard';
  core_values: string[];
  salary_estimates: SalaryEstimate[];
  culture_ratings?: CultureRatings;
  employee_reviews: EmployeeReview[];
  critics: CriticInsight[];
  benefits: string[];
  competitors: string[];
  recent_news: string;
  sources: string[];
  fetched_at: string;
}

const SYNTHESIS_SYSTEM_PROMPT = `You are an interview-prep researcher. You have raw web search results about a company and a target role, and you must produce a structured CompanyDossier as JSON.

Rules:
- Return ONLY valid JSON matching the schema below — no prose, no code fences.
- Ground every claim in the search snippets. If a fact is not in the snippets, leave the field empty ([] or "" or 0). Never invent data.
- Tailor "interview_focus" to the target ROLE (using the JD title / level / tech stack). General "leetcode + behavioral" answers are useless.
- For "salary_estimates", only include entries you can support with at least one snippet that mentions an amount; round to whole numbers in the listed currency.
- For "culture_ratings", give 0.0–5.0 floats. If a dimension is not covered by snippets, use 0.
- "interview_difficulty": one of "easy", "medium", "hard", "very_hard".
- "sources": list 3–8 distinct source URLs you actually used.
- "fetched_at": today's ISO date.

Schema:
{
  "company": string,
  "hiring_strategy": string,        // 2–4 sentences, what they look for and how they recruit
  "interview_focus": string,        // 2–4 sentences, ROLE-SPECIFIC focus areas
  "interview_difficulty": "easy"|"medium"|"hard"|"very_hard",
  "core_values": string[],          // 3–6 short phrases
  "salary_estimates": [ { "title": string, "location": string, "min": number, "max": number, "currency": string, "source": string, "confidence": "low"|"medium"|"high" } ],
  "culture_ratings": {
    "overall": number, "work_life_balance": number, "career_growth": number,
    "compensation": number, "management": number, "diversity": number,
    "review_count": string, "data_sources": string[]
  },
  "employee_reviews": [ { "quote": string, "sentiment": "positive"|"mixed"|"negative", "source": string, "role"?: string } ],
  "critics": [ { "category": string, "complaint": string, "frequency": "occasionally"|"frequently"|"widespread" } ],
  "benefits": string[],
  "competitors": string[],
  "recent_news": string,            // 2–4 sentences on recent developments
  "sources": string[],
  "fetched_at": "YYYY-MM-DD"
}`;

export class CompanyResearchEngine {
  private llmHelper: any;
  public searchProvider: TavilyClient | null = null;

  constructor(llmHelper: any) {
    this.llmHelper = llmHelper;
  }

  public setSearchProvider(provider: TavilyClient) {
    this.searchProvider = provider;
  }

  private buildQueries(company: string, jd: JDContext): string[] {
    const role = jd.title || 'engineer';
    const loc = jd.location || '';
    const year = new Date().getFullYear();
    return [
      `${company} interview process hiring strategy ${role}`,
      `${company} ${role} salary ${loc} ${jd.level || ''} levels.fyi glassdoor`.trim(),
      `${company} employee reviews glassdoor culture work life balance management`,
      `${company} recent news ${year} layoffs funding product launches`,
    ];
  }

  /** Compress search results into a token-efficient summary block for the LLM. */
  private formatSearchResults(searches: TavilySearchResponse[]): string {
    const lines: string[] = [];
    for (const s of searches) {
      lines.push(`\n## QUERY: ${s.query}`);
      if (s.answer) lines.push(`SUMMARY: ${s.answer}`);
      for (const r of s.results.slice(0, 5)) {
        const snippet = (r.content || '').slice(0, 600).replace(/\s+/g, ' ').trim();
        lines.push(`- [${r.title}](${r.url})\n  ${snippet}`);
      }
    }
    return lines.join('\n');
  }

  public async researchCompany(company: string, jd: JDContext, _verbose: boolean = false): Promise<CompanyDossier> {
    if (!this.searchProvider) {
      // No Tavily key — return a minimal LLM-only dossier so the UI still renders something.
      return this.llmOnlyDossier(company, jd);
    }

    const queries = this.buildQueries(company, jd);
    console.log(`[CompanyResearchEngine] researching ${company} via ${queries.length} queries`);
    const searches = await this.searchProvider.searchMany(queries, { depth: 'basic', maxResults: 5 });
    const totalResults = searches.reduce((n, s) => n + s.results.length, 0);
    console.log(`[CompanyResearchEngine] got ${totalResults} total results across ${searches.length} queries`);

    if (totalResults === 0) {
      // All searches failed (likely quota exhausted) — fall back to LLM-only
      return this.llmOnlyDossier(company, jd);
    }

    const evidence = this.formatSearchResults(searches);
    const userPrompt = [
      `TARGET COMPANY: ${company}`,
      `TARGET ROLE: ${JSON.stringify(jd)}`,
      `TODAY: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'WEB SEARCH RESULTS:',
      evidence,
    ].join('\n');

    const dossier = (await this.llmHelper.generateJson(SYNTHESIS_SYSTEM_PROMPT, userPrompt)) as CompanyDossier;
    // Backstop the company field and date — LLM sometimes drops them
    dossier.company = dossier.company || company;
    dossier.fetched_at = dossier.fetched_at || new Date().toISOString().slice(0, 10);
    return dossier;
  }

  /** Fallback when no search provider is wired — LLM relies purely on prior knowledge. */
  private async llmOnlyDossier(company: string, jd: JDContext): Promise<CompanyDossier> {
    console.log('[CompanyResearchEngine] no search results — using LLM-only dossier');
    const userPrompt = [
      `TARGET COMPANY: ${company}`,
      `TARGET ROLE: ${JSON.stringify(jd)}`,
      `TODAY: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'NO WEB SEARCH RESULTS AVAILABLE. Use only your prior knowledge of this company.',
      'Mark all confidence as "low". Set sources to ["LLM prior knowledge"].',
      'Leave salary_estimates and culture_ratings empty if you are unsure of specific numbers.',
    ].join('\n');

    const dossier = (await this.llmHelper.generateJson(SYNTHESIS_SYSTEM_PROMPT, userPrompt)) as CompanyDossier;
    dossier.company = dossier.company || company;
    dossier.fetched_at = dossier.fetched_at || new Date().toISOString().slice(0, 10);
    if (!dossier.sources?.length) dossier.sources = ['LLM prior knowledge'];
    return dossier;
  }
}
