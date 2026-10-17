export interface RawItem {
  source_uid: string;
  title: string;
  start: string | null;
  end: string | null;
  venue: string | null;
  address: string | null;
  url: string | null;
  description: string | null;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  /** full body text (e.g. RSS content:encoded, HTML stripped); used for event-date lookup, not stored */
  content?: string | null;
}

export interface ExtractResult {
  items: RawItem[];
  warnings: string[];
  error?: string;
}
