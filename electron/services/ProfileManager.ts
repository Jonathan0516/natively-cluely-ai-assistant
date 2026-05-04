import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { extractTextFromFile, extractStructured, ResumeStructured, JDStructured } from './ProfileExtractor';

interface PersistedState {
  resume: ResumeStructured | null;
  jd: JDStructured | null;
  profileMode: boolean;
  resumeUploadedAt: string | null;
  jdUploadedAt: string | null;
}

const EMPTY_STATE: PersistedState = {
  resume: null,
  jd: null,
  profileMode: false,
  resumeUploadedAt: null,
  jdUploadedAt: null,
};

export class ProfileManager {
  private static instance: ProfileManager | null = null;
  private state: PersistedState = { ...EMPTY_STATE };
  private storePath: string;

  private constructor() {
    this.storePath = path.join(app.getPath('userData'), 'profile.json');
    this.load();
  }

  public static getInstance(): ProfileManager {
    if (!ProfileManager.instance) ProfileManager.instance = new ProfileManager();
    return ProfileManager.instance;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.state = { ...EMPTY_STATE, ...parsed };
      }
    } catch (e: any) {
      console.warn('[ProfileManager] Failed to load profile.json, starting fresh:', e.message);
      this.state = { ...EMPTY_STATE };
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e: any) {
      console.error('[ProfileManager] Failed to persist profile.json:', e.message);
    }
  }

  public async ingestResume(filePath: string, llmHelper: any): Promise<{ success: boolean; error?: string }> {
    const t0 = Date.now();
    try {
      console.log(`[ProfileManager] ingestResume: extracting text from ${filePath}`);
      const text = await extractTextFromFile(filePath);
      console.log(`[ProfileManager] ingestResume: text length=${text.length}, calling LLM…`);
      const structured = await extractStructured<ResumeStructured>(llmHelper, 'resume', text);
      console.log(`[ProfileManager] ingestResume: LLM ok in ${Date.now() - t0}ms, persisting`);
      this.state.resume = structured;
      this.state.resumeUploadedAt = new Date().toISOString();
      this.persist();
      console.log(`[ProfileManager] ingestResume: done in ${Date.now() - t0}ms`);
      return { success: true };
    } catch (e: any) {
      console.error(`[ProfileManager] ingestResume error after ${Date.now() - t0}ms:`, e);
      return { success: false, error: e.message || String(e) };
    }
  }

  public async ingestJDFromText(rawText: string, llmHelper: any): Promise<{ success: boolean; error?: string }> {
    const t0 = Date.now();
    try {
      const text = (rawText || '').trim();
      if (text.length < 30) {
        return { success: false, error: 'JD text is too short. Paste at least a few sentences.' };
      }
      console.log(`[ProfileManager] ingestJDFromText: text length=${text.length}, calling LLM…`);
      const { extractStructured } = require('./ProfileExtractor');
      const structured = await extractStructured(llmHelper, 'jd', text);
      this.state.jd = structured;
      this.state.jdUploadedAt = new Date().toISOString();
      this.persist();
      console.log(`[ProfileManager] ingestJDFromText: done in ${Date.now() - t0}ms`);
      return { success: true };
    } catch (e: any) {
      console.error(`[ProfileManager] ingestJDFromText error after ${Date.now() - t0}ms:`, e);
      return { success: false, error: e.message || String(e) };
    }
  }

  public async ingestJD(filePath: string, llmHelper: any): Promise<{ success: boolean; error?: string }> {
    const t0 = Date.now();
    try {
      console.log(`[ProfileManager] ingestJD: extracting text from ${filePath}`);
      const text = await extractTextFromFile(filePath);
      console.log(`[ProfileManager] ingestJD: text length=${text.length}, calling LLM…`);
      const structured = await extractStructured<JDStructured>(llmHelper, 'jd', text);
      console.log(`[ProfileManager] ingestJD: LLM ok in ${Date.now() - t0}ms, persisting`);
      this.state.jd = structured;
      this.state.jdUploadedAt = new Date().toISOString();
      this.persist();
      console.log(`[ProfileManager] ingestJD: done in ${Date.now() - t0}ms`);
      return { success: true };
    } catch (e: any) {
      console.error(`[ProfileManager] ingestJD error after ${Date.now() - t0}ms:`, e);
      return { success: false, error: e.message || String(e) };
    }
  }

  public deleteResume(): void {
    this.state.resume = null;
    this.state.resumeUploadedAt = null;
    if (!this.state.jd) this.state.profileMode = false;
    this.persist();
  }

  public deleteJD(): void {
    this.state.jd = null;
    this.state.jdUploadedAt = null;
    this.persist();
  }

  public setMode(enabled: boolean): void {
    this.state.profileMode = enabled && !!this.state.resume;
    this.persist();
  }

  public isModeOn(): boolean {
    return this.state.profileMode && !!this.state.resume;
  }

  public hasResume(): boolean {
    return !!this.state.resume;
  }

  public getStatus(): { hasProfile: boolean; profileMode: boolean; name?: string; role?: string; totalExperienceYears?: number } {
    const r = this.state.resume;
    return {
      hasProfile: !!r,
      profileMode: this.state.profileMode,
      name: r?.identity.name,
      role: r?.experience?.[0]?.role,
      totalExperienceYears: r?.totalExperienceYears,
    };
  }

  public getProfileData(): any {
    const r = this.state.resume;
    const jd = this.state.jd;
    if (!r) {
      return {
        identity: null,
        skills: [],
        experience: [],
        projects: [],
        education: [],
        experienceCount: 0,
        projectCount: 0,
        nodeCount: 0,
        totalExperienceYears: 0,
        hasActiveJD: !!jd,
        activeJD: jd
          ? {
              title: jd.title,
              company: jd.company,
              location: jd.location,
              level: jd.level,
              technologies: jd.technologies,
              requirements: jd.requirements,
              keywords: jd.keywords,
            }
          : null,
      };
    }
    const expCount = r.experience?.length || 0;
    const projCount = r.projects?.length || 0;
    const eduCount = r.education?.length || 0;
    const certCount = r.certifications?.length || 0;
    const achCount = r.achievements?.length || 0;
    return {
      identity: r.identity,
      skills: r.skills || [],
      experience: r.experience || [],
      projects: r.projects || [],
      education: r.education || [],
      certifications: r.certifications || [],
      achievements: r.achievements || [],
      experienceCount: expCount,
      projectCount: projCount,
      educationCount: eduCount,
      // "Nodes" = total knowledge items extracted from the resume
      nodeCount: expCount + projCount + eduCount + certCount + achCount,
      totalExperienceYears: r.totalExperienceYears || 0,
      hasActiveJD: !!jd,
      activeJD: jd
        ? {
            title: jd.title,
            company: jd.company,
            location: jd.location,
            level: jd.level,
            technologies: jd.technologies,
            requirements: jd.requirements,
            keywords: jd.keywords,
          }
        : null,
    };
  }

  /**
   * Build the compact resume + JD JSON payload shared by every prompt-injection
   * variant. Returns null if no resume is uploaded. Kept stable across requests
   * so OpenAI / Anthropic prompt cache can hit on the prefix.
   */
  private buildCompactProfilePayload(): { resume: string; jd: string | null } | null {
    const r = this.state.resume;
    if (!r) return null;

    const compactResume = {
      name: r.identity.name,
      summary: r.identity.summary || '',
      total_years: r.totalExperienceYears,
      skills: r.skills?.slice(0, 30) || [],
      experience: (r.experience || []).slice(0, 6).map(e => ({
        company: e.company,
        role: e.role,
        start: e.start_date,
        end: e.end_date,
        highlights: (e.bullets || []).slice(0, 4),
      })),
      projects: (r.projects || []).slice(0, 4).map(p => ({
        name: p.name,
        tech: p.technologies,
        description: p.description,
      })),
      education: (r.education || []).slice(0, 3).map(ed => ({
        institution: ed.institution,
        degree: ed.degree,
        field: ed.field,
      })),
    };

    const jd = this.state.jd;
    const compactJD = jd
      ? {
          title: jd.title,
          company: jd.company,
          level: jd.level,
          min_years: jd.min_years_experience,
          must_have: jd.requirements?.slice(0, 8) || [],
          nice_to_have: jd.nice_to_haves?.slice(0, 5) || [],
          tech: jd.technologies || [],
        }
      : null;

    return {
      resume: JSON.stringify(compactResume),
      jd: compactJD ? JSON.stringify(compactJD) : null,
    };
  }

  /**
   * Compact prompt-injection block for the generic "answer on behalf of the
   * candidate" modes. Gated by the profileMode toggle.
   */
  public buildContextBlock(): string {
    if (!this.isModeOn()) return '';
    const payload = this.buildCompactProfilePayload();
    if (!payload) return '';

    const lines = [
      '<user_profile>',
      'You are answering interview questions ON BEHALF OF this candidate.',
      'Use the resume facts as ground truth: cite their real companies, roles, projects, technologies.',
      'When the JD is present, frame answers to highlight overlap with the target role.',
      'Never invent experience. If asked about something not in the resume, say so briefly and pivot to a related real experience.',
      '',
      'RESUME (compact JSON):',
      payload.resume,
    ];
    if (payload.jd) {
      lines.push('', 'TARGET JD (compact JSON):', payload.jd);
    }
    lines.push('</user_profile>');
    return lines.join('\n');
  }

  /**
   * System-design-specific injection. Bypasses the profileMode toggle and
   * frames the resume + JD as input for technology + scale calibration, not as
   * a "ghostwrite the answer" instruction. Returns '' if no resume is uploaded.
   */
  public buildSystemDesignContextBlock(): string {
    const payload = this.buildCompactProfilePayload();
    if (!payload) return '';

    const lines = [
      '<user_profile>',
      'CONTEXT FOR SYSTEM DESIGN ONLY — not a request to ghostwrite the candidate\'s words.',
      'Use the candidate\'s actual stack from the resume to ground concrete technology choices (databases, caches, queues, languages). Prefer what they have shipped over name-dropping unfamiliar tools.',
      'When a target JD is present, calibrate scale, depth, and tooling to that role: match the JD\'s tech where possible, and pitch the design at the JD\'s seniority level.',
      'Do NOT fabricate experience. If the question targets tech the candidate has not used, design with the closest tools they know and acknowledge the swap in one short line.',
      'Do NOT pad the answer with resume bullet points or JD quotes — they are signals for choosing tech and depth, not content to recite.',
      '',
      'RESUME (compact JSON):',
      payload.resume,
    ];
    if (payload.jd) {
      lines.push('', 'TARGET JD (compact JSON):', payload.jd);
    }
    lines.push('</user_profile>');
    return lines.join('\n');
  }

  public reset(): void {
    this.state = { ...EMPTY_STATE };
    this.persist();
  }
}
