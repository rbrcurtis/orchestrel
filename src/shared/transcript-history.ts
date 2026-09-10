export interface TranscriptHistoryRecord {
  id: string;
  message: unknown;
}

export interface TranscriptHistoryRequest {
  revision?: string;
  before?: string;
  after?: string;
  prefix?: string;
  anchorOnly?: boolean;
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
}
