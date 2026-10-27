import { ContactImportError } from './errors';
import { CsvDelimiter, ParsedCsvFile, ParsedCsvRow } from './types';

function stripUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function countDelimiterOutsideQuotes(line: string, delimiter: CsvDelimiter): number {
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && character === delimiter) {
      count += 1;
    }
  }
  return count;
}

export function detectCsvDelimiter(content: string): CsvDelimiter {
  const firstNonEmptyLine = stripUtf8Bom(content)
    .split(/\r\n|\n|\r/)
    .find((line) => line.trim().length > 0);
  if (!firstNonEmptyLine) {
    throw new ContactImportError('CSV_EMPTY');
  }
  return countDelimiterOutsideQuotes(firstNonEmptyLine, ';') > countDelimiterOutsideQuotes(firstNonEmptyLine, ',')
    ? ';'
    : ',';
}

interface ParsedCellsRow {
  cells: string[];
  rowNumber: number;
}

function parseCsvCells(content: string, delimiter: CsvDelimiter): ParsedCellsRow[] {
  const rows: ParsedCellsRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let rowNumber = 1;
  let rowStart = 1;

  const commitRow = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim().length > 0)) {
      rows.push({ cells, rowNumber: rowStart });
    }
    cells = [];
    cell = '';
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (inQuotes && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && character === delimiter) {
      cells.push(cell);
      cell = '';
      continue;
    }

    if (!inQuotes && (character === '\n' || character === '\r')) {
      commitRow();
      if (character === '\r' && content[index + 1] === '\n') {
        index += 1;
      }
      rowNumber += 1;
      rowStart = rowNumber;
      continue;
    }

    cell += character;
  }

  if (inQuotes) {
    throw new ContactImportError('CSV_UNTERMINATED_QUOTE');
  }

  if (cells.length > 0 || cell.length > 0) {
    commitRow();
  }
  return rows;
}

function normalizeHeaders(headers: string[]): string[] {
  const normalized = headers.map((header) => header.trim());
  if (normalized.some((header) => header.length === 0)) {
    throw new ContactImportError('MAPPING_INVALID');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new ContactImportError('CSV_DUPLICATE_HEADER');
  }
  return normalized;
}

export function parseCsv(content: string, explicitDelimiter?: CsvDelimiter): ParsedCsvFile {
  const normalizedContent = stripUtf8Bom(content);
  const delimiter = explicitDelimiter ?? detectCsvDelimiter(normalizedContent);
  const parsedRows = parseCsvCells(normalizedContent, delimiter);
  if (parsedRows.length === 0) {
    throw new ContactImportError('CSV_EMPTY');
  }

  const headers = normalizeHeaders(parsedRows[0].cells);
  const rows: ParsedCsvRow[] = parsedRows.slice(1).map((row) => {
    const values: Record<string, string> = {};
    headers.forEach((header, index) => {
      values[header] = row.cells[index] ?? '';
    });
    return { rowNumber: row.rowNumber, values };
  });

  return { delimiter, headers, rows };
}
