export type ContactImportErrorCode =
  | 'INPUT_REQUIRED'
  | 'UNSUPPORTED_INPUT'
  | 'XLSX_NOT_ENABLED'
  | 'CSV_EMPTY'
  | 'CSV_UNTERMINATED_QUOTE'
  | 'CSV_DUPLICATE_HEADER'
  | 'MAPPING_REQUIRED'
  | 'MAPPING_INVALID'
  | 'UNSAFE_MANIFEST_OUTPUT'
  | 'UNSAFE_REPORT_OUTPUT'
  | 'INVALID_OPERATION_ID'
  | 'UNSUPPORTED_ARGUMENT';

/** Error text is intentionally the code only, so CLI failures cannot echo row data. */
export class ContactImportError extends Error {
  constructor(public readonly code: ContactImportErrorCode) {
    super(code);
    this.name = 'ContactImportError';
  }
}
