import * as fs from 'fs';
import * as path from 'path';

export type DocKind = 'resume' | 'jd';

export interface ResumeStructured {
  identity: {
    name: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    github?: string;
    website?: string;
    summary?: string;
  };
  skills: string[];
  experience: Array<{
    company: string;
    role: string;
    start_date: string;
    end_date: string | null;
    bullets: string[];
  }>;
  projects: Array<{ name: string; description: string; technologies: string[]; url?: string }>;
  education: Array<{ institution: string; degree: string; field: string; start_date: string; end_date: string | null; gpa?: string }>;
  achievements: Array<{ title: string; description: string; date?: string }>;
  certifications: Array<{ name: string; issuer: string; date?: string }>;
  totalExperienceYears: number;
}

export interface JDStructured {
  title: string;
  company: string;
  location: string;
  description_summary: string;
  level: 'intern' | 'entry' | 'mid' | 'senior' | 'staff' | 'principal';
  employment_type: 'full_time' | 'part_time' | 'contract' | 'internship';
  min_years_experience: number;
  compensation_hint: string;
  requirements: string[];
  nice_to_haves: string[];
  responsibilities: string[];
  technologies: string[];
  keywords: string[];
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    return (result?.text || '').trim();
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return (result?.value || '').trim();
  }

  if (ext === '.txt' || ext === '.md') {
    return fs.readFileSync(filePath, 'utf-8').trim();
  }

  throw new Error(`Unsupported file type: ${ext}. Use PDF, DOCX, or TXT.`);
}

const RESUME_SYSTEM_PROMPT = `You extract structured data from resumes for an interview-prep tool.
Return ONLY valid JSON matching the schema below. No prose, no code fences.

Rules:
- Use ISO format YYYY-MM for dates. Use null for ongoing end_date.
- "totalExperienceYears" = sum of professional (post-graduation) full-time experience, in years (decimals allowed).
- "skills": deduplicated, lowercase technology/skill names.
- Each "bullets" entry should be a single accomplishment, kept verbatim from the resume when possible.
- If a field is missing in the source, use [] or "" — never invent data.

Schema:
{
  "identity": { "name": string, "email"?: string, "phone"?: string, "location"?: string, "linkedin"?: string, "github"?: string, "website"?: string, "summary"?: string },
  "skills": string[],
  "experience": [ { "company": string, "role": string, "start_date": "YYYY-MM", "end_date": "YYYY-MM"|null, "bullets": string[] } ],
  "projects": [ { "name": string, "description": string, "technologies": string[], "url"?: string } ],
  "education": [ { "institution": string, "degree": string, "field": string, "start_date": "YYYY-MM", "end_date": "YYYY-MM"|null, "gpa"?: string } ],
  "achievements": [ { "title": string, "description": string, "date"?: string } ],
  "certifications": [ { "name": string, "issuer": string, "date"?: string } ],
  "totalExperienceYears": number
}`;

const JD_SYSTEM_PROMPT = `You extract structured data from job descriptions for an interview-prep tool.
Return ONLY valid JSON matching the schema below. No prose, no code fences.

Rules:
- "level": one of "intern" | "entry" | "mid" | "senior" | "staff" | "principal". Infer from years required and seniority signals if not stated.
- "employment_type": "full_time" | "part_time" | "contract" | "internship".
- "technologies": deduplicated, lowercase tech stack mentioned.
- "keywords": 5–15 short tags representing the role focus (e.g. "distributed systems", "go", "k8s").
- If the field is unknown, use a sensible default ("" / [] / 0).

Schema:
{
  "title": string,
  "company": string,
  "location": string,
  "description_summary": string,
  "level": "intern"|"entry"|"mid"|"senior"|"staff"|"principal",
  "employment_type": "full_time"|"part_time"|"contract"|"internship",
  "min_years_experience": number,
  "compensation_hint": string,
  "requirements": string[],
  "nice_to_haves": string[],
  "responsibilities": string[],
  "technologies": string[],
  "keywords": string[]
}`;

export async function extractStructured<T = any>(
  llmHelper: any,
  kind: DocKind,
  rawText: string
): Promise<T> {
  if (!rawText || rawText.length < 30) {
    throw new Error('Document text is empty or too short to parse.');
  }
  const truncated = rawText.length > 18000 ? rawText.slice(0, 18000) : rawText;
  const systemPrompt = kind === 'resume' ? RESUME_SYSTEM_PROMPT : JD_SYSTEM_PROMPT;
  const userPrompt = `Source document:\n\n${truncated}`;
  return llmHelper.generateJson(systemPrompt, userPrompt) as Promise<T>;
}
