export interface Note {
  id: string;
  text: string;
}

export function createNote(id: string, text: string): Note {
  return { id, text };
}
