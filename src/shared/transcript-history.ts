export interface TranscriptHistoryRecord {
  id: string;
  message: unknown;
}

// One history page. A card loads its newest page, then asks only for the records
// after the last one it holds; each scroll-up page behind that is this size too.
// The byte cap in the reader still wins when a page would be very large.
export const TRANSCRIPT_PAGE_SIZE = 100;

export interface TranscriptHistoryRequest {
  revision?: string;
  before?: string;
  after?: string;
  prefix?: string;
  anchorOnly?: boolean;
}

// Where the session itself began. A page carries only a window of records, so the
// synthetic init record — record 0 — falls off the newest page on any session longer
// than TRANSCRIPT_PAGE_SIZE. This rides along with every page and snapshot so the
// transcript can still open with its "Session started" divider.
export interface TranscriptSessionStart {
  model: string;
  timestamp?: number;
}

export interface TranscriptHistoryPage {
  sessionId: string;
  revision: string;
  records: TranscriptHistoryRecord[];
  before: string | null;
  after: string | null;
  prefix: string;
  hasOlder: boolean;
  hasNewer: boolean;
  reset: boolean;
  sessionStart?: TranscriptSessionStart;
}
