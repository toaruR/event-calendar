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
}

export interface ExtractResult {
  items: RawItem[];
  warnings: string[];
  error?: string;
}
