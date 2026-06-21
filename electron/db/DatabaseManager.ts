
import Database = require('better-sqlite3');
import * as path from 'path';
import { app } from 'electron';
import * as fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { CloudClient } from '../services/CloudClient';

// Onboarding demo meeting id. Must be a UUID because the cloud meetings table id is uuid.
const DEMO_MEETING_ID = '00000000-0000-0000-0000-0000000000de';

// Interfaces for our data objects
export interface Meeting {
    id: string;
    title: string;
    date: string; // ISO string
    duration: string;
    summary: string;
    detailedSummary?: {
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
        actionItemsTitle?: string;
        keyPointsTitle?: string;
        sections?: Array<{ title: string; bullets: string[] }>;
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
        turnId?: string;
    }>;
    calendarEventId?: string;
    source?: 'manual' | 'calendar';
    isProcessed?: boolean;
    tokenUsage?: any;
}

export class DatabaseManager {
    private static instance: DatabaseManager;
    private db: Database.Database | null = null;
    private dbPath: string;
    private resolvedExtPath: string = '';

    private constructor() {
        const userDataPath = app.getPath('userData');
        this.dbPath = path.join(userDataPath, 'natively.db');
        this.init();
    }

    public static getInstance(): DatabaseManager {
        if (!DatabaseManager.instance) {
            DatabaseManager.instance = new DatabaseManager();
        }
        return DatabaseManager.instance;
    }

    // Meetings + transcripts + ai_interactions + custom notes are stored in the cloud
    // (per-account). The local SQLite below still backs RAG (chunks/embeddings), the
    // Knowledge subsystem, and device-local app_state.
    private get cloud() {
        return CloudClient.getInstance();
    }

    private static durationString(durationMs: number): string {
        const ms = durationMs || 0;
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    private static rowToMeetingSummary(row: any): Meeting {
        const s = row.summary_json || {};
        return {
            id: row.id, title: row.title, date: row.created_at,
            duration: DatabaseManager.durationString(row.duration_ms),
            summary: s.legacySummary || '', detailedSummary: s.detailedSummary,
            calendarEventId: row.calendar_event_id, source: row.source,
            transcript: [], usage: [],
        };
    }

    private static rowToMeetingDetails(data: any): Meeting {
        const m = data.meeting; const s = m.summary_json || {};
        const transcript = (data.transcripts || []).map((r: any) => ({ speaker: r.speaker, text: r.content, timestamp: r.timestamp_ms }));
        const usage = (data.ai_interactions || []).map((r: any) => {
            // metadata_json is either a bare array (legacy: items) or an object { items?, turnId? }.
            const md = r.metadata_json;
            const items = Array.isArray(md) ? md : (md && Array.isArray(md.items) ? md.items : undefined);
            const turnId = (md && !Array.isArray(md) && typeof md.turnId === 'string') ? md.turnId : undefined;
            return { type: r.type, timestamp: r.timestamp, question: r.user_query, answer: r.ai_response, items, turnId };
        });
        return {
            id: m.id, title: m.title, date: m.created_at,
            duration: DatabaseManager.durationString(m.duration_ms),
            summary: s.legacySummary || '', detailedSummary: s.detailedSummary,
            calendarEventId: m.calendar_event_id, source: m.source,
            transcript, usage, tokenUsage: m.token_usage_json ?? null,
        };
    }


    private init() {
        try {
            console.log(`[DatabaseManager] Initializing database at ${this.dbPath}`);
            // Ensure directory exists (though userData usually does)
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`[DatabaseManager] Created directory: ${dir}`);
            } else {
                console.log(`[DatabaseManager] Directory exists: ${dir}`);
                try {
                    const files = fs.readdirSync(dir);
                    console.log(`[DatabaseManager] Directory contents:`, files);
                    const dbExists = fs.existsSync(this.dbPath);
                    if (dbExists) {
                        const stats = fs.statSync(this.dbPath);
                        console.log(`[DatabaseManager] Found existing DB. Size: ${stats.size} bytes`);
                    } else {
                        console.log(`[DatabaseManager] No existing DB found at ${this.dbPath}. Creating new one.`);
                    }
                } catch (e) {
                    console.error('[DatabaseManager] Error checking directory/file:', e);
                }
            }

            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');

            // Load sqlite-vec extension for native vector search
            try {
                // 1. sqlite-vec's getLoadablePath() returns a path inside app.asar
                //    (e.g. .../app.asar/node_modules/sqlite-vec-darwin-arm64/vec0.dylib)
                //    but dlopen() needs real files on disk, not files inside the asar archive.
                //    electron-builder's asarUnpack puts them in app.asar.unpacked instead.
                // 2. better-sqlite3's loadExtension() auto-appends the platform extension
                //    (.dylib/.so/.dll), so we strip it to avoid vec0.dylib.dylib.
                let extPath = sqliteVec.getLoadablePath();
                extPath = extPath.replace('app.asar', 'app.asar.unpacked');
                extPath = extPath.replace(/\.(dylib|so|dll)$/, '');
                this.db.loadExtension(extPath);
                this.resolvedExtPath = extPath; // Store for worker thread access
                console.log('[DatabaseManager] sqlite-vec extension loaded successfully');
            } catch (extErr) {
                console.error('[DatabaseManager] Failed to load sqlite-vec extension:', extErr);
                console.warn('[DatabaseManager] Vector search will fall back to JS cosine similarity');
            }

            this.runMigrations();
        } catch (error) {
            console.error('[DatabaseManager] Failed to initialize database:', error);
            throw error;
        }
    }

    // ============================================
    // PRAGMA user_version Migration System
    // ============================================
    // Each version is applied exactly once, in order.
    // New migrations append a new `if (version < N)` block.
    // ============================================

    private runMigrations() {
        if (!this.db) return;

        const version = (this.db.pragma('user_version', { simple: true }) as number) || 0;
        console.log(`[DatabaseManager] Current schema version: ${version}`);

        // Version 0 → 1: Initial schema (all core tables)
        if (version < 1) {
            console.log('[DatabaseManager] Applying migration v0 → v1: Initial schema');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS meetings (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    start_time INTEGER,
                    duration_ms INTEGER,
                    summary_json TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    calendar_event_id TEXT,
                    source TEXT,
                    is_processed INTEGER DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS transcripts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT,
                    speaker TEXT,
                    content TEXT,
                    timestamp_ms INTEGER,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ai_interactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT,
                    type TEXT,
                    timestamp INTEGER,
                    user_query TEXT,
                    ai_response TEXT,
                    metadata_json TEXT,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    speaker TEXT,
                    start_timestamp_ms INTEGER,
                    end_timestamp_ms INTEGER,
                    cleaned_text TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    embedding BLOB,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS chunk_summaries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL UNIQUE,
                    summary_text TEXT NOT NULL,
                    embedding BLOB,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS embedding_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL,
                    chunk_id INTEGER,
                    status TEXT DEFAULT 'pending',
                    retry_count INTEGER DEFAULT 0,
                    error_message TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    processed_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON chunks(meeting_id);

                CREATE TABLE IF NOT EXISTS user_profile (
                    id INTEGER PRIMARY KEY,
                    structured_json TEXT NOT NULL,
                    compact_persona TEXT NOT NULL,
                    intro_short TEXT,
                    intro_interview TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS resume_nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category TEXT,
                    title TEXT,
                    organization TEXT,
                    start_date TEXT,
                    end_date TEXT,
                    duration_months INTEGER,
                    text_content TEXT,
                    tags TEXT,
                    embedding BLOB
                );
            `);
            this.db.pragma('user_version = 1');
        }

        // Version 1 → 2: Add columns for existing installs (safe for fresh installs too)
        if (version < 2) {
            console.log('[DatabaseManager] Applying migration v1 → v2: Add meetings columns');
            // For fresh installs these columns already exist from v1, so we guard with try/catch.
            // Unlike the old code, these are versioned and run exactly once.
            const columnsToAdd = [
                "ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT",
                "ALTER TABLE meetings ADD COLUMN source TEXT",
                "ALTER TABLE meetings ADD COLUMN is_processed INTEGER DEFAULT 1"
            ];
            for (const sql of columnsToAdd) {
                try { this.db.exec(sql); } catch (e) { /* Column already exists from v1 CREATE */ }
            }
            this.db.pragma('user_version = 2');
        }

        // Version 2 → 3: sqlite-vec virtual tables for native vector search
        if (version < 3) {
            console.log('[DatabaseManager] Applying migration v2 → v3: vec0 virtual tables');
            try {
                // Create vec0 virtual table for chunk embeddings (dynamic dimension)
                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                        chunk_id INTEGER PRIMARY KEY,
                        embedding float
                    );
                `);

                // Create vec0 virtual table for summary embeddings (dynamic dimension)
                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_summaries USING vec0(
                        summary_id INTEGER PRIMARY KEY,
                        embedding float
                    );
                `);

                // Migrate existing chunk embeddings from BLOB column to vec0 table
                this.migrateExistingEmbeddings();

                console.log('[DatabaseManager] vec0 virtual tables created successfully');
            } catch (e) {
                console.error('[DatabaseManager] vec0 migration failed (sqlite-vec may not be loaded):', e);
                console.warn('[DatabaseManager] VectorStore will fall back to JS cosine similarity');
            }
            this.db.pragma('user_version = 3');
        }

        // Version 3 → 4: Drop strict 768-dim vec0 tables to allow flexible embedding dimensions
        if (version < 4) {
            console.log('[DatabaseManager] Applying migration v3 → v4: Drop strict dimension vec0 tables');
            try {
                this.db.exec('DROP TABLE IF EXISTS vec_chunks;');
                this.db.exec('DROP TABLE IF EXISTS vec_summaries;');

                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                        chunk_id INTEGER PRIMARY KEY,
                        embedding float
                    );
                `);

                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_summaries USING vec0(
                        summary_id INTEGER PRIMARY KEY,
                        embedding float
                    );
                `);

                this.migrateExistingEmbeddings();
                console.log('[DatabaseManager] vec0 virtual tables recreated for flexible dimensions');
            } catch (e) {
                console.error('[DatabaseManager] vec0 migration v4 failed:', e);
            }
            this.db.pragma('user_version = 4');
        }

        // Version 4 → 5: Add embedding provider and dimensions columns
        if (version < 5) {
            console.log('[DatabaseManager] Applying migration v4 → v5: Add embedding provider/dimensions columns');
            const columnsToAdd = [
                "ALTER TABLE meetings ADD COLUMN embedding_provider TEXT",
                "ALTER TABLE meetings ADD COLUMN embedding_dimensions INTEGER"
            ];
            for (const sql of columnsToAdd) {
                try { this.db.exec(sql); } catch (e) { /* Column already exists */ }
            }
            this.db.pragma('user_version = 5');
        }

        // Version 5 → 6: Add app_state table for KV storage (Ollama pull state, etc)
        if (version < 6) {
            console.log('[DatabaseManager] Applying migration v5 → v6: Add app_state table');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
            `);
            this.db.pragma('user_version = 6');
        }

        // Version 6 → 7: Add indexes on transcripts and ai_interactions meeting_id
        // (Previously missing — causes O(N) full-table scans when fetching meeting details)
        if (version < 7) {
            console.log('[DatabaseManager] Applying migration v6 → v7: Add meeting_id indexes');
            try {
                this.db.exec('CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON transcripts(meeting_id);');
                this.db.exec('CREATE INDEX IF NOT EXISTS idx_ai_interactions_meeting ON ai_interactions(meeting_id, timestamp);');
                console.log('[DatabaseManager] Meeting ID indexes created successfully');
            } catch (e) {
                console.error('[DatabaseManager] Failed to create indexes (non-fatal):', e);
            }
            this.db.pragma('user_version = 7');
        }

        // Version 7 → 8: Provision per-dimension vec0 tables (NOTE: this v8 ran in two broken
        // iterations for some users — first with float[1536] single table, then with correct per-dim
        // tables. The v9 migration below corrects any v8 that used the old broken schema.)
        if (version < 8) {
            console.log('[DatabaseManager] Applying migration v7 → v8: Provision per-dimension vec0 tables');
            // Drop the legacy single-dim tables from v3/v4 if they exist and are unusable
            try { this.db.exec('DROP TABLE IF EXISTS vec_chunks;'); } catch (_) {}
            try { this.db.exec('DROP TABLE IF EXISTS vec_summaries;'); } catch (_) {}

            for (const dim of DatabaseManager.KNOWN_DIMS) {
                this.ensureVecTableForDim(dim);
            }
            console.log('[DatabaseManager] v8 migration: per-dimension vec0 tables provisioned');
            this.db.pragma('user_version = 8');
        }

        // Version 8 → 9: Ensure per-dimension tables exist.
        // Required for DBs already at v8 but with the old broken float[1536] single-table schema,
        // or with the first incorrect v8 migration that didn't provision KNOWN_DIMS tables.
        if (version < 9) {
            console.log('[DatabaseManager] Applying migration v8 → v9: Ensure per-dimension vec0 tables exist');
            // Drop old single-dim orphan tables if they exist (float[1536] schema)
            try { this.db.exec('DROP TABLE IF EXISTS vec_chunks;'); } catch (_) {}
            try { this.db.exec('DROP TABLE IF EXISTS vec_summaries;'); } catch (_) {}

            let allOk = true;
            for (const dim of DatabaseManager.KNOWN_DIMS) {
                this.ensureVecTableForDim(dim);
                // Verify the table actually exists after provisioning
                try {
                    this.db.prepare(`SELECT count(*) FROM vec_chunks_${dim} LIMIT 1`).get();
                } catch (e) {
                    console.error(`[DatabaseManager] v9: vec_chunks_${dim} still missing after provisioning:`, e);
                    allOk = false;
                }
            }
            if (allOk) {
                console.log('[DatabaseManager] v9 migration: all per-dimension vec0 tables verified ✓');
            } else {
                console.warn('[DatabaseManager] v9 migration: some tables missing — sqlite-vec extension may not be loaded');
            }
            this.db.pragma('user_version = 9');
        }

        // Version 9 → 10: Add UNIQUE constraint on embedding_queue(meeting_id, chunk_id).
        // This enables INSERT OR IGNORE in EmbeddingPipeline.queueMeeting() to silently
        // skip duplicate rows when queueMeeting() is called more than once for the same meeting.
        // SQLite doesn't support ADD CONSTRAINT on existing tables, so we recreate the table
        // using the standard rename-create-copy-drop pattern.
        if (version < 10) {
            console.log('[DatabaseManager] Applying migration v9 → v10: Add UNIQUE constraint to embedding_queue');
            try {
                // Wrap all steps in an explicit better-sqlite3 transaction for atomicity.
                // If any step throws, the entire migration is rolled back cleanly —
                // preventing the dangerous half-renamed table state that a bare exec() chain would leave.
                const migrate = this.db.transaction(() => {
                    // Step 1: Rename the existing table to a temp name
                    this.db!.exec('ALTER TABLE embedding_queue RENAME TO embedding_queue_old;');

                    // Step 2: Recreate with the UNIQUE(meeting_id, chunk_id) constraint
                    this.db!.exec(`
                        CREATE TABLE embedding_queue (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            meeting_id TEXT NOT NULL,
                            chunk_id INTEGER,
                            status TEXT DEFAULT 'pending',
                            retry_count INTEGER DEFAULT 0,
                            error_message TEXT,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                            processed_at TEXT,
                            UNIQUE(meeting_id, chunk_id)
                        );
                    `);

                    // Step 3: Copy rows; INSERT OR IGNORE silently drops any pre-existing duplicates
                    this.db!.exec(`
                        INSERT OR IGNORE INTO embedding_queue
                            (id, meeting_id, chunk_id, status, retry_count, error_message, created_at, processed_at)
                        SELECT id, meeting_id, chunk_id, status, retry_count, error_message, created_at, processed_at
                        FROM embedding_queue_old;
                    `);

                    // Step 4: Drop the backup
                    this.db!.exec('DROP TABLE embedding_queue_old;');
                });
                migrate();
                console.log('[DatabaseManager] v10 migration: embedding_queue UNIQUE constraint added ✓');
            } catch (e) {
                console.error('[DatabaseManager] v10 migration failed — table structure unchanged:', e);
                // user_version still advances. We do NOT retry — a failed rename leaves
                // embedding_queue_old behind; retrying would cause "table already exists".
                // In the failure case, INSERT OR IGNORE in queueMeeting() will still work
                // for natural uniqueness (same meeting queued twice picks up existing rows),
                // just without DB-enforced deduplication.
            }
            this.db.pragma('user_version = 10');
        }

        // Version 10 → 11: Add modes, mode_reference_files, and mode_note_sections tables
        if (version < 11) {
            console.log('[DatabaseManager] Applying migration v10 → v11: Add modes tables');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS modes (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    template_type TEXT NOT NULL DEFAULT 'general',
                    custom_context TEXT NOT NULL DEFAULT '',
                    is_active INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS mode_reference_files (
                    id TEXT PRIMARY KEY,
                    mode_id TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(mode_id) REFERENCES modes(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS mode_note_sections (
                    id TEXT PRIMARY KEY,
                    mode_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(mode_id) REFERENCES modes(id) ON DELETE CASCADE
                );
            `);
            // Seed a default "General" mode as active
            const defaultModeId = 'mode_general_default';
            this.db.prepare(`
                INSERT OR IGNORE INTO modes (id, name, template_type, custom_context, is_active)
                VALUES (?, ?, ?, ?, 1)
            `).run(defaultModeId, 'General', 'general', '');
            this.db.pragma('user_version = 11');
        }

        // Version 11 → 12: Seed note sections for the default General mode if missing
        if (version < 12) {
            console.log('[DatabaseManager] Applying migration v11 → v12: Seed default General mode note sections');
            const defaultModeId = 'mode_general_default';
            const modeExists = this.db.prepare('SELECT id FROM modes WHERE id = ?').get(defaultModeId);
            const existing = modeExists
                ? this.db.prepare('SELECT id FROM mode_note_sections WHERE mode_id = ?').get(defaultModeId)
                : null;
            if (modeExists && !existing) {
                const defaultSections = [
                    { title: 'Summary',      description: 'High-level summary of the conversation.' },
                    { title: 'Action items', description: 'Tasks and follow-ups identified.' },
                    { title: 'Key points',   description: 'Important points discussed.' },
                ];
                const insertSection = this.db.prepare(
                    'INSERT OR IGNORE INTO mode_note_sections (id, mode_id, title, description, sort_order) VALUES (?, ?, ?, ?, ?)'
                );
                defaultSections.forEach((s, i) => {
                    insertSection.run(`ns_general_${i}`, defaultModeId, s.title, s.description, i);
                });
            }
            this.db.pragma('user_version = 12');
        }

        // Version 12 → 13: Backfill note sections for any mode instance that has none
        if (version < 13) {
            console.log('[DatabaseManager] Applying migration v12 → v13: Backfill missing mode note sections');
            const BACKFILL_SECTIONS: Record<string, Array<{ title: string; description: string }>> = {
                general: [
                    { title: 'Summary',      description: 'High-level summary of the conversation.' },
                    { title: 'Action items', description: 'Tasks and follow-ups identified.' },
                    { title: 'Key points',   description: 'Important points discussed.' },
                ],
                'looking-for-work': [
                    { title: 'Follow-up actions',       description: 'Next interview steps or additional materials I said I would send if applicable.' },
                    { title: 'Overview',                description: 'Overview of the interview, the company, and general structure.' },
                    { title: 'Questions and responses', description: 'All questions asked to me during the interview and answers that gave.' },
                    { title: 'Areas to improve',        description: 'What I could have done better during the interview.' },
                    { title: 'Role details',            description: 'Anything discussed about the position, salary expectations, etc.' },
                ],
                sales: [
                    { title: 'Action Items',        description: 'All action items that were said I would do after the meeting.' },
                    { title: 'Outcome',             description: 'Did I close the sale and what was the outcome of the conversation.' },
                    { title: 'Prospect background', description: 'Background and context on who I was selling to.' },
                    { title: 'Discovery',           description: 'What the prospect said during discovery.' },
                    { title: 'Product',             description: "How I pitched the product and the prospect's reaction." },
                    { title: 'Objections',          description: 'Objections from the prospect if there were any.' },
                ],
                recruiting: [
                    { title: 'Action Items',          description: 'All action items that I have to do after the meeting.' },
                    { title: 'Experience and skills', description: "Candidate's previous work experience and skills discussed." },
                    { title: 'Quality of responses',  description: 'If there were questions asked, how well and how accurately the candidate answered each question.' },
                    { title: 'Interest in company',   description: 'What the candidate said about their interest in the company.' },
                    { title: 'Role expectations',     description: 'Anything discussed about the position, salary expectations, etc.' },
                ],
                'team-meet': [
                    { title: 'Action Items',           description: 'All action items that were said I would do after the meeting.' },
                    { title: 'Announcements',          description: 'Any team-wide announcements from the meeting.' },
                    { title: 'Team updates',           description: "Each team member's progress, accomplishments, and current focus." },
                    { title: 'Challenges or blockers', description: 'Any issues or obstacles raised that may affect progress.' },
                    { title: 'Decisions made',         description: 'Key decisions or agreements reached during the meeting.' },
                ],
                lecture: [
                    { title: 'Follow-up work', description: 'Follow-up reading, assignments, or tasks to complete.' },
                    { title: 'Topic',          description: 'Main subject or theme of the lecture.' },
                    { title: 'Key concepts',   description: 'Core ideas or frameworks covered.' },
                    { title: 'Content',        description: 'All content from the lecture with incredibly detailed bullet notes.' },
                ],
                'technical-interview': [
                    { title: 'Problems covered', description: 'Each problem asked, the approach used, and the outcome.' },
                    { title: 'Concepts tested',  description: 'Key algorithms, data structures, or system design concepts that came up.' },
                    { title: 'What went well',   description: 'Approaches or explanations that landed well.' },
                    { title: 'Areas to study',   description: 'Topics or gaps identified that need more preparation.' },
                    { title: 'Action items',     description: 'Follow-up steps — e.g. send code, study specific topics, await next round.' },
                ],
            };

            const allModes = this.db.prepare('SELECT id, template_type FROM modes').all() as Array<{ id: string; template_type: string }>;
            const insertSection = this.db.prepare(
                'INSERT OR IGNORE INTO mode_note_sections (id, mode_id, title, description, sort_order) VALUES (?, ?, ?, ?, ?)'
            );
            for (const mode of allModes) {
                const hasSection = this.db.prepare('SELECT id FROM mode_note_sections WHERE mode_id = ? LIMIT 1').get(mode.id);
                if (!hasSection) {
                    const sections = BACKFILL_SECTIONS[mode.template_type] ?? [];
                    sections.forEach((s, i) => {
                        insertSection.run(`ns_bf_${mode.id}_${i}`, mode.id, s.title, s.description, i);
                    });
                    if (sections.length > 0) {
                        console.log(`[DatabaseManager] Backfilled ${sections.length} sections for mode "${mode.id}" (${mode.template_type})`);
                    }
                }
            }
            this.db.pragma('user_version = 13');
        }

        // Version 13 → 14: Add profile_custom_notes table
        if (version < 14) {
            console.log('[DatabaseManager] Applying migration v13 → v14: Add profile_custom_notes table');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS profile_custom_notes (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    content TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT OR IGNORE INTO profile_custom_notes (id, content) VALUES (1, '');
            `);
            this.db.pragma('user_version = 14');
        }

        // Version 14 → 15: Add token_usage_json column on meetings for per-meeting LLM/STT cost analysis
        if (version < 15) {
            console.log('[DatabaseManager] Applying migration v14 → v15: Add token_usage_json column to meetings');
            try {
                this.db.exec("ALTER TABLE meetings ADD COLUMN token_usage_json TEXT");
            } catch (e) { /* column may already exist */ }
            this.db.pragma('user_version = 15');
        }

        console.log('[DatabaseManager] Migrations completed.');
    }

    // ============================================
    // Profile Custom Notes
    // ============================================


    public async getCustomNotes(): Promise<string> {
        try { const res = await this.cloud.getCustomNotes(); return res?.content ?? ''; }
        catch (e) { console.error('[DatabaseManager] getCustomNotes failed:', e); return ''; }
    }


    public async saveCustomNotes(content: string): Promise<void> {
        try { await this.cloud.saveCustomNotes(content); }
        catch (e) { console.error('[DatabaseManager] saveCustomNotes failed:', e); }
    }

    // ============================================
    // Modes CRUD
    // ============================================

    public getModes(): any[] {
        if (!this.db) return [];
        try {
            return this.db.prepare('SELECT * FROM modes ORDER BY created_at ASC').all();
        } catch (e) {
            console.error('[DatabaseManager] getModes failed:', e);
            return [];
        }
    }

    public getActiveMode(): any | null {
        if (!this.db) return null;
        try {
            return this.db.prepare('SELECT * FROM modes WHERE is_active = 1 LIMIT 1').get() ?? null;
        } catch (e) {
            console.error('[DatabaseManager] getActiveMode failed:', e);
            return null;
        }
    }

    public createMode(mode: { id: string; name: string; templateType: string; customContext: string }): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
                INSERT INTO modes (id, name, template_type, custom_context, is_active)
                VALUES (?, ?, ?, ?, 0)
            `).run(mode.id, mode.name, mode.templateType, mode.customContext);
        } catch (e) {
            console.error('[DatabaseManager] createMode failed:', e);
        }
    }

    public updateMode(id: string, updates: { name?: string; templateType?: string; customContext?: string }): void {
        if (!this.db) return;
        try {
            if (updates.name !== undefined) {
                this.db.prepare('UPDATE modes SET name = ? WHERE id = ?').run(updates.name, id);
            }
            if (updates.templateType !== undefined) {
                this.db.prepare('UPDATE modes SET template_type = ? WHERE id = ?').run(updates.templateType, id);
            }
            if (updates.customContext !== undefined) {
                this.db.prepare('UPDATE modes SET custom_context = ? WHERE id = ?').run(updates.customContext, id);
            }
        } catch (e) {
            console.error('[DatabaseManager] updateMode failed:', e);
        }
    }

    public deleteMode(id: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM modes WHERE id = ?').run(id);
        } catch (e) {
            console.error('[DatabaseManager] deleteMode failed:', e);
        }
    }

    public setActiveMode(id: string | null): void {
        if (!this.db) return;
        try {
            const txn = this.db.transaction(() => {
                this.db!.prepare('UPDATE modes SET is_active = 0').run();
                if (id) {
                    const result = this.db!.prepare('UPDATE modes SET is_active = 1 WHERE id = ?').run(id);
                    if (result.changes === 0) {
                        console.warn(`[DatabaseManager] setActiveMode: no mode found with id "${id}" — active mode cleared`);
                    }
                }
            });
            txn();
        } catch (e) {
            console.error('[DatabaseManager] setActiveMode failed:', e);
        }
    }

    public getReferenceFiles(modeId: string): any[] {
        if (!this.db) return [];
        try {
            return this.db.prepare('SELECT * FROM mode_reference_files WHERE mode_id = ? ORDER BY created_at ASC').all(modeId);
        } catch (e) {
            console.error('[DatabaseManager] getReferenceFiles failed:', e);
            return [];
        }
    }

    public addReferenceFile(file: { id: string; modeId: string; fileName: string; content: string }): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
                INSERT INTO mode_reference_files (id, mode_id, file_name, content)
                VALUES (?, ?, ?, ?)
            `).run(file.id, file.modeId, file.fileName, file.content);
        } catch (e) {
            console.error('[DatabaseManager] addReferenceFile failed:', e);
        }
    }

    public deleteReferenceFile(id: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM mode_reference_files WHERE id = ?').run(id);
        } catch (e) {
            console.error('[DatabaseManager] deleteReferenceFile failed:', e);
        }
    }

    // ── Note Sections ─────────────────────────────────────────────

    public getNoteSections(modeId: string): any[] {
        if (!this.db) return [];
        try {
            return this.db.prepare(
                'SELECT * FROM mode_note_sections WHERE mode_id = ? ORDER BY sort_order ASC, created_at ASC'
            ).all(modeId);
        } catch (e) {
            console.error('[DatabaseManager] getNoteSections failed:', e);
            return [];
        }
    }

    public addNoteSection(section: { id: string; modeId: string; title: string; description: string; sortOrder: number }): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
                INSERT INTO mode_note_sections (id, mode_id, title, description, sort_order)
                VALUES (?, ?, ?, ?, ?)
            `).run(section.id, section.modeId, section.title, section.description, section.sortOrder);
        } catch (e) {
            console.error('[DatabaseManager] addNoteSection failed:', e);
        }
    }

    public updateNoteSection(id: string, updates: { title?: string; description?: string; sortOrder?: number }): void {
        if (!this.db) return;
        try {
            if (updates.title !== undefined) {
                this.db.prepare('UPDATE mode_note_sections SET title = ? WHERE id = ?').run(updates.title, id);
            }
            if (updates.description !== undefined) {
                this.db.prepare('UPDATE mode_note_sections SET description = ? WHERE id = ?').run(updates.description, id);
            }
            if (updates.sortOrder !== undefined) {
                this.db.prepare('UPDATE mode_note_sections SET sort_order = ? WHERE id = ?').run(updates.sortOrder, id);
            }
        } catch (e) {
            console.error('[DatabaseManager] updateNoteSection failed:', e);
        }
    }

    public deleteNoteSection(id: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM mode_note_sections WHERE id = ?').run(id);
        } catch (e) {
            console.error('[DatabaseManager] deleteNoteSection failed:', e);
        }
    }

    public deleteAllNoteSections(modeId: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM mode_note_sections WHERE mode_id = ?').run(modeId);
        } catch (e) {
            console.error('[DatabaseManager] deleteAllNoteSections failed:', e);
        }
    }

    // ============================================
    // System KV Store (app_state)
    // ============================================

    public getAppState(key: string): string | null {
        if (!this.db) return null;
        try {
            const stmt = this.db.prepare('SELECT value FROM app_state WHERE key = ?');
            const row = stmt.get(key) as { value: string } | undefined;
            return row ? row.value : null;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to get app_state for key: ${key}`, error);
            return null;
        }
    }

    public setAppState(key: string, value: string): void {
        if (!this.db) return;
        try {
            const stmt = this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
            stmt.run(key, value);
        } catch (error) {
            console.error(`[DatabaseManager] Failed to set app_state for key: ${key}`, error);
        }
    }

    public deleteAppState(key: string): void {
        if (!this.db) return;
        try {
            const stmt = this.db.prepare('DELETE FROM app_state WHERE key = ?');
            stmt.run(key);
        } catch (error) {
            console.error(`[DatabaseManager] Failed to delete app_state for key: ${key}`, error);
        }
    }

    /**
     * One-time migration: Copy existing BLOB embeddings into vec0 virtual tables.
     */
    private migrateExistingEmbeddings(): void {
        if (!this.db) return;
        const db = this.db;

        // Migrate chunk embeddings
        try {
            const chunkRows = db.prepare(
                'SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL'
            ).all() as any[];

            if (chunkRows.length > 0) {
                const insert = db.prepare(
                    'INSERT OR IGNORE INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)'
                );
                const migrateAll = db.transaction(() => {
                    for (const row of chunkRows) {
                        try {
                            insert.run(row.id, row.embedding);
                        } catch (err) {
                            // On mismatch (e.g. mixed 768 and 3072 dims), nullify to re-embed later
                            db.prepare('UPDATE chunks SET embedding = NULL WHERE id = ?').run(row.id);
                        }
                    }
                });
                migrateAll();
                console.log(`[DatabaseManager] Migrated ${chunkRows.length} chunk embeddings to vec_chunks`);
            }
        } catch (e) {
            console.error('[DatabaseManager] Failed to migrate chunk embeddings:', e);
        }

        // Migrate summary embeddings
        try {
            const summaryRows = db.prepare(
                'SELECT id, embedding FROM chunk_summaries WHERE embedding IS NOT NULL'
            ).all() as any[];

            if (summaryRows.length > 0) {
                const insert = db.prepare(
                    'INSERT OR IGNORE INTO vec_summaries(summary_id, embedding) VALUES (?, ?)'
                );
                const migrateAll = db.transaction(() => {
                    for (const row of summaryRows) {
                        try {
                            insert.run(row.id, row.embedding);
                        } catch (err) {
                            db.prepare('UPDATE chunk_summaries SET embedding = NULL WHERE id = ?').run(row.id);
                        }
                    }
                });
                migrateAll();
                console.log(`[DatabaseManager] Migrated ${summaryRows.length} summary embeddings to vec_summaries`);
            }
        } catch (e) {
            console.error('[DatabaseManager] Failed to migrate summary embeddings:', e);
        }
    }

    /**
     * Known embedding dimension tiers.
     * Used by the v8 migration, delete operations, and table provisioning.
     * When a new provider dimension is encountered at runtime, ensureVecTableForDim() handles it.
     */
    public static readonly KNOWN_DIMS: readonly number[] = [768, 1536, 3072];

    /** Cache: dimensions for which vec0 tables have already been verified/created this session. */
    private ensuredDims = new Set<number>();

    /**
     * Lazily create a per-dimension vec0 table pair if not already present.
     * Called by v8 migration and at runtime when a new embedding dimension is first seen.
     * Uses an in-memory cache to avoid redundant CREATE TABLE IF NOT EXISTS on every insert.
     */
    public ensureVecTableForDim(dim: number): void {
        if (this.ensuredDims.has(dim)) return; // Already verified this session
        if (!this.db) return;
        // Guard against SQL injection: dim must be a positive integer
        if (!Number.isInteger(dim) || dim <= 0 || dim > 100_000) {
            console.error(`[DatabaseManager] Invalid dimension for vec0 table: ${dim}`);
            return;
        }
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks_${dim} USING vec0(
                    chunk_id INTEGER PRIMARY KEY,
                    embedding float[${dim}]
                );
            `);
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_summaries_${dim} USING vec0(
                    summary_id INTEGER PRIMARY KEY,
                    embedding float[${dim}]
                );
            `);
            this.ensuredDims.add(dim);
            console.log(`[DatabaseManager] Ensured vec0 tables for dim=${dim}`);
        } catch (e) {
            console.error(`[DatabaseManager] Failed to create vec0 tables for dim=${dim}:`, e);
        }
    }

    /**
     * Check if sqlite-vec is available (any per-dimension vec0 table must exist)
     */
    public hasVecExtension(): boolean {
        if (!this.db) return false;
        try {
            // Check the most common dimension (Ollama 768); any may suffice
            this.db.prepare("SELECT count(*) FROM vec_chunks_768 LIMIT 1").get();
            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================
    // Public API
    // ============================================

    /**
     * Expose the raw database instance for external managers (e.g. ProfileDatabaseManager).
     */
    public getDb(): Database.Database | null {
        return this.db;
    }

    /** Path to the SQLite database file on disk. Used by worker threads. */
    public getDbPath(): string {
        return this.dbPath;
    }

    /**
     * Resolved sqlite-vec extension path (without platform file suffix).
     * Used by worker threads that open their own DB connection.
     */
    public getExtPath(): string {
        return this.resolvedExtPath;
    }


    public async saveMeeting(meeting: Meeting, startTimeMs: number, durationMs: number): Promise<void> {
        const summaryJson = { legacySummary: meeting.summary, detailedSummary: meeting.detailedSummary };
        const transcripts = (meeting.transcript || []).map(s => ({ speaker: s.speaker, content: s.text, timestamp_ms: s.timestamp }));
        const aiInteractions = (meeting.usage || []).map(u => {
            let items: any = null;
            if (u.items) items = u.items;
            else if (u.type === 'followup_questions' && Array.isArray(u.answer)) items = u.answer;
            // metadata_json now carries both the legacy `items` array and the turn id used to
            // attribute per-Q&A token usage. Stored as an object; reads stay backward-compatible
            // with old rows where metadata_json was a bare array (see getMeetingDetails).
            let metadata: any = null;
            if (u.turnId || items) {
                metadata = {};
                if (items) metadata.items = items;
                if (u.turnId) metadata.turnId = u.turnId;
            }
            const answerText = Array.isArray(u.answer) ? null : (u.answer || null);
            return { type: u.type, timestamp: u.timestamp, user_query: u.question || null, ai_response: answerText, metadata_json: metadata };
        });
        const meetingRow = {
            id: meeting.id, title: meeting.title, start_time: startTimeMs, duration_ms: durationMs,
            summary_json: summaryJson, token_usage_json: meeting.tokenUsage ?? null,
            calendar_event_id: meeting.calendarEventId || null, source: meeting.source || 'manual',
            is_processed: meeting.isProcessed ?? true, created_at: meeting.date,
        };
        await this.cloud.saveMeeting({ meeting: meetingRow, transcripts, ai_interactions: aiInteractions });
        console.log(`[DatabaseManager] Saved meeting ${meeting.id} to cloud`);
    }


    public async updateMeetingTitle(id: string, title: string): Promise<boolean> {
        const res = await this.cloud.updateMeetingTitle(id, title);
        return !!res?.updated;
    }


    public async updateMeetingSummary(id: string, updates: { overview?: string, actionItems?: string[], keyPoints?: string[], actionItemsTitle?: string, keyPointsTitle?: string }): Promise<boolean> {
        const res = await this.cloud.updateMeetingSummary(id, updates);
        return !!res?.updated;
    }


    public async getRecentMeetings(limit: number = 50): Promise<Meeting[]> {
        const rows = await this.cloud.getRecentMeetings(limit);
        return (rows || []).map(r => DatabaseManager.rowToMeetingSummary(r));
    }


    public async getMeetingDetails(id: string): Promise<Meeting | null> {
        const data = await this.cloud.getMeetingDetails(id);
        if (!data || !data.meeting) return null;
        return DatabaseManager.rowToMeetingDetails(data);
    }


    public async deleteMeeting(id: string): Promise<boolean> {
        const res = await this.cloud.deleteMeeting(id);
        return !!res?.deleted;
    }


    public async getUnprocessedMeetings(): Promise<Meeting[]> {
        const rows = await this.cloud.getUnprocessedMeetings();
        return (rows || []).map(r => ({ ...DatabaseManager.rowToMeetingSummary(r), isProcessed: false }));
    }


    public async clearAllData(): Promise<boolean> {
        try {
            const rows = await this.cloud.getRecentMeetings(1000);
            await Promise.all((rows || []).map(r => this.cloud.deleteMeeting(r.id)));
            return true;
        } catch (e) { console.error('[DatabaseManager] clearAllData failed:', e); return false; }
    }

    public async seedDemoMeeting(): Promise<void> {
        // Check if demo meeting already exists in the cloud
        try {
            const existing = await this.cloud.getMeetingDetails(DEMO_MEETING_ID);
            if (existing && existing.meeting) {
                console.log('[DatabaseManager] Demo meeting already exists, skipping seed.');
                return;
            }
        } catch (e) {
            console.error('[DatabaseManager] seedDemoMeeting existence check failed:', e);
            return;
        }

        const demoId = DEMO_MEETING_ID;

        // Set date to today 9:30 AM
        const today = new Date();
        today.setHours(9, 30, 0, 0);

        const durationMs = 300000; // 5 min

        const summaryMarkdown = `# Overview

Natively is a real-time AI meeting assistant designed to help you stay focused, informed, and fast-moving during calls. Get live insights while you speak, instant answers to questions, and structured notes after every meeting.

# Getting Started

### Start a Session
Click **Start Session** from the dashboard.
Join a scheduled meeting and start directly from the meeting notification.

### During a Meeting
- Use the **five quick action buttons** for real-time assistance
- Show or hide Natively at any time:
  - **Mac**: Cmd + B
  - **Windows**: Ctrl + B
- Move the widget anywhere on your screen by hovering over the top pill and dragging

# Main Features

## Five Quick Action Buttons
- **What to answer**: Instantly generates a context-aware response to the current topic.
- **Clarify**: Asks a targeted, senior-level clarifying question to establish constraints.
- **Recap**: Generates a comprehensive summary of the conversation so far.
- **Follow Up Question**: Suggests strategic questions you can ask to drive the conversation.
- **Answer**: Manually trigger a response or use voice input to ask specific questions.

## Meeting Insights (Launcher)
- **Smart Note Taking**: Automatically captures key points, action items, and structured summaries.
- **Summary**: A concise high-level brief of the entire meeting.
- **Transcript**: Full real-time speech-to-text transcript, available during and after the call.
- **Usage**: Track your interaction history and see how Natively assisted you.

## Live Insights
Click **Live Insights** during a call to view:
- Real-time questions and prompts
- Detected keywords and topics
- Context-aware suggestions based on the conversation
- Click any insight to get an instant response.

## AI Chat
- Type your question and press **Enter** or click **Submit**
- Enable **Smart Mode** for advanced reasoning and coding assistance

## Screenshots
- **Full Screen Screenshot**: Cmd + H
- **Selective Screenshot**: Cmd + Shift + H

# Making the Most of Natively

### Custom Context
Upload resumes, project briefs, sales scripts, or other documents to tailor responses to your workflow. (coming soon).

### Language Preferences
Go to **Settings → Language Preferences** to:
- Change input and output language
- Enable real-time translation during calls

### Undetectability
Unlock the **Undetectability** add-on to keep Natively invisible during screen sharing.

# Interface Basics

- **Dashboard**: Start meetings and view recent activity
- **Start Session**: Begin a new meeting instantly
- **Settings**: Configure API keys, language, and visibility
- **History**: Review past meetings, notes, and transcripts

# API Setup

1. Open **Settings**
2. Scroll to **Credentials**
3. Add your API keys:
   - **Gemini**
   - **Groq**
4. To enable real-time transcription, select the location of your **Google Cloud service account JSON file**.

If you don’t already have one, follow the steps below to create it.

# Creating a Google Speech-to-Text Service Account

## 1. Create or Select a Project
- Open **Google Cloud Console**
- Create a new project or select an existing one
- Ensure billing is enabled

## 2. Enable Speech-to-Text API
- Go to **APIs & Services → Library**
- Enable **Speech-to-Text API**

## 3. Create a Service Account
- Navigate to **IAM & Admin → Service Accounts**
- Click **Create Service Account**
- **Name**: natively-stt
- **Description**: optional

## 4. Assign Permissions
- Grant the following role: **Speech-to-Text User** (\`roles/speech.client\`)

## 5. Create a JSON Key
- Open the service account
- Go to **Keys → Add Key → Create new key**
- Select **JSON**
- Download the file

**Once downloaded, return to Settings → Credentials in Natively and select this file to complete setup.**

# Free Google Cloud Credit (New Users)

New Google Cloud accounts receive **$300 in free credits**, valid for 90 days.

To activate:
1. Visit [cloud.google.com](https://cloud.google.com)
2. Click **Get started for free**
3. Sign in with a Google account
4. Add billing details (card required)
5. Activate the free trial

The credit can be used for Speech-to-Text and is sufficient for extended testing and regular usage.

# Support

If you need help with setup or usage, contact us anytime at:
natively.contact@gmail.com`;

        const demoMeeting: Meeting = {
            id: demoId,
            title: "Natively Demo & Guide",
            date: today.toISOString(),
            duration: "5:00",
            summary: "Complete guide to using Natively - your real-time AI meeting assistant.",
            detailedSummary: {
                overview: summaryMarkdown,
                actionItems: [],
                keyPoints: []
            },
            transcript: [
                { speaker: 'interviewer', text: "Welcome to Natively! Let me show you how it works.", timestamp: 0 },
                { speaker: 'user', text: "Thanks! I'm excited to try it out.", timestamp: 5000 },
                { speaker: 'interviewer', text: "You have 5 quick action buttons. 'What to answer' listens to the conversation and suggests what you should say.", timestamp: 10000 },
                { speaker: 'user', text: "That sounds helpful for interviews.", timestamp: 18000 },
                { speaker: 'interviewer', text: "Check out the 'How to Use' section in the notes for API setup instructions.", timestamp: 20000 },
                { speaker: 'interviewer', text: "'Clarify' asks a targeted question to get missing constraints. 'Recap' summarizes the entire conversation so far.", timestamp: 22000 },
                { speaker: 'user', text: "What about the other buttons?", timestamp: 30000 },
                { speaker: 'interviewer', text: "'Follow Up Questions' suggests questions you can ask. 'Answer' lets you speak a question and get an instant response.", timestamp: 35000 },
                { speaker: 'user', text: "Can I take screenshots during calls?", timestamp: 45000 },
                { speaker: 'interviewer', text: "Yes! Press Cmd+H for full screen or Cmd+Shift+H to select an area. The AI will analyze it and help you.", timestamp: 50000 },
                { speaker: 'user', text: "How do I hide Natively during screen share?", timestamp: 60000 },
                { speaker: 'interviewer', text: "Press Cmd+B to toggle visibility anytime. You can also enable undetectable mode in settings.", timestamp: 65000 },
                { speaker: 'user', text: "This is amazing. What happens after the call?", timestamp: 75000 },
                { speaker: 'interviewer', text: "You get detailed meeting notes with action items, key points, full transcript, and a log of all AI interactions.", timestamp: 80000 }
            ],
            usage: [
                { type: 'assist', timestamp: 15000, question: 'What features does Natively have?', answer: 'Natively offers 5 quick action buttons, screenshot analysis, real-time transcription, and comprehensive meeting notes.' },
                { type: 'followup', timestamp: 40000, question: 'How do the action buttons work?', answer: 'Each button serves a specific purpose: suggest answers, clarify questions, recap conversations, generate follow-up questions, or get instant voice-to-answer responses.' }
            ],
            isProcessed: true
        };

        await this.saveMeeting(demoMeeting, today.getTime(), durationMs);
        console.log('[DatabaseManager] Seeded demo meeting.');
    }
}
