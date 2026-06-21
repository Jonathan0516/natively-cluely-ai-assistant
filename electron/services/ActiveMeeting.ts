// electron/services/ActiveMeeting.ts
// Ambient holder for the id of the meeting currently being recorded/processed.
//
// LLM calls during a meeting (live suggestions, Q&A) and its post-meeting summary all run
// through the shared LLMHelper, which has no session reference. This module hands those calls
// the current meeting id so the backend can tag usage_events.meeting_id — powering the
// per-meeting "Usage Details" view. main.ts sets it on meeting start; MeetingPersistence
// reuses it as the saved meeting id and clears it once the meeting is fully persisted.
//
// Single active meeting at a time (the overlay model). When no meeting is active, get()
// returns null and calls are recorded with meeting_id = null (e.g. one-off chat).

import { randomUUID } from 'crypto';

let currentMeetingId: string | null = null;

export const ActiveMeeting = {
    /** Begin a new meeting; generates and returns its id. */
    start(): string {
        currentMeetingId = randomUUID();
        return currentMeetingId;
    },
    /** Current meeting id, or null when no meeting is active. */
    get(): string | null {
        return currentMeetingId;
    },
    /** Clear once the meeting is fully persisted (incl. post-meeting summary). */
    clear(): void {
        currentMeetingId = null;
    },
};
