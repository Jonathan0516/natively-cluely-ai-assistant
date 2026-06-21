// electron/services/ActiveTurn.ts
// Ambient holder for the id of the current "turn" — one Q&A exchange. A turn usually spans
// several LLM calls (intent classification + answer generation), which must all share one
// turn_id so the meeting-detail "Analysis" view can break usage down per Q&A.
//
// Lifecycle (no per-mode wiring needed — centralised on the call + the interaction log):
//   - LLMHelper calls `get()`  → lazily mints a turn id on the FIRST call of a turn, and
//     returns the same id for every subsequent call until the turn ends.
//   - SessionTracker.pushUsage / logUsage record the interaction, stamp it with `peek()`,
//     then call `end()` → the next LLM call mints a fresh turn id.
//
// Calls with no enclosing interaction (e.g. post-meeting summary/title generation) still get
// a turn id, but no interaction references it, so the UI simply shows them in a "system" bucket.

import { randomUUID } from 'crypto';

let currentTurnId: string | null = null;

export const ActiveTurn = {
    /** Current turn id, minting one on the first LLM call of a turn. */
    get(): string {
        if (!currentTurnId) currentTurnId = randomUUID();
        return currentTurnId;
    },
    /** Current turn id without minting (null if no calls have happened since the last end()). */
    peek(): string | null {
        return currentTurnId;
    },
    /** Close the current turn so the next LLM call starts a fresh one. */
    end(): void {
        currentTurnId = null;
    },
};
