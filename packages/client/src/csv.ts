import type { DraftRow } from '@geo-copilot/core';

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some(c => c.length > 0)) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c.length > 0)) rows.push(row);
  return rows;
}

export interface CsvMapping {
  /** Column header that holds the entity name. */
  name: string;
  /** header -> propertyId for plain text/url values. */
  values?: Record<string, string> | undefined;
  /** header -> relation typeId; cell holds the target entity NAME to resolve. */
  relationNames?: Record<string, string> | undefined;
  /** header -> relation typeId; cell holds the target entity ID. */
  relationIds?: Record<string, string> | undefined;
  /** Type ids to assign to every row (e.g. the Audit type). */
  typeIds?: string[] | undefined;
}

/**
 * Maps a curator CSV batch (the audits-import workflow) into draft rows.
 * Unknown columns are ignored; empty cells are skipped.
 */
export function csvToDrafts(text: string, mapping: CsvMapping, sourceName = 'batch.csv'): DraftRow[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  const idx = new Map(header.map((h, i) => [h.trim(), i] as const));
  const col = (name: string): number | undefined => idx.get(name.trim());

  const nameCol = col(mapping.name);
  if (nameCol === undefined) {
    throw new Error(`CSV is missing the name column "${mapping.name}". Headers: ${header.join(', ')}`);
  }

  const drafts: DraftRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r] as string[];
    const name = (cells[nameCol] ?? '').trim();
    if (name.length === 0) continue;

    const values: Array<{ propertyId: string; text: string }> = [];
    for (const [headerName, propertyId] of Object.entries(mapping.values ?? {})) {
      const c = col(headerName);
      const cell = c !== undefined ? (cells[c] ?? '').trim() : '';
      if (cell.length > 0) values.push({ propertyId, text: cell });
    }

    const relations: DraftRow['relations'] = [];
    for (const [headerName, typeId] of Object.entries(mapping.relationNames ?? {})) {
      const c = col(headerName);
      const cell = c !== undefined ? (cells[c] ?? '').trim() : '';
      if (cell.length > 0) relations.push({ typeId, toEntityName: cell });
    }
    for (const [headerName, typeId] of Object.entries(mapping.relationIds ?? {})) {
      const c = col(headerName);
      const cell = c !== undefined ? (cells[c] ?? '').trim() : '';
      if (cell.length > 0) relations.push({ typeId, toEntityId: cell });
    }

    drafts.push({
      ref: `row:${r + 1}`, // 1-based with header, matches what the curator sees in a spreadsheet
      name,
      typeIds: mapping.typeIds,
      values,
      relations,
      source: `${sourceName}:${r + 1}`,
    });
  }
  return drafts;
}
