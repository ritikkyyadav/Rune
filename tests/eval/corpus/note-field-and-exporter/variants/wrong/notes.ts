export interface Note {
  id: string;
  text: string;
  tags: string[];
}

export function createNote(id: string, text: string, tags: string[] = []): Note {
  return { id, text, tags: [...tags] };
}
