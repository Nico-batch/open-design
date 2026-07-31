export interface Design {
  id: string;
  name: string;
  canvas_json: string;
  width: number;
  height: number;
  thumbnail_url: string | null;
  twenty_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewsRecord {
  id: string;
  title: string | null;
  imageUrl: string | null;
}

export interface Page {
  id: string;
  design_id: string;
  title: string;
  canvas_json: string;
  sort_order: number;
  created_at: string;
}

export interface DesignWithPages extends Design {
  pages: Page[];
}

export interface Template {
  id: string;
  name: string;
  category: string;
  canvas_json: string;
  width: number;
  height: number;
  thumbnail_url: string | null;
  sort_order: number;
}
