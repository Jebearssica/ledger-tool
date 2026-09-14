/**
 * Error sentinels shared between the importers and the UI.
 *
 * This module deliberately imports nothing. The UI needs to recognise the
 * "PDF is encrypted" condition, and importing that constant from `pdf.ts` would
 * statically pull ~430 KB of pdf.js into the entry chunk, defeating the lazy
 * loading the whole parser strategy depends on (AGENTS.md §2.1).
 */

/** Sentinel error name asking the user for a PDF password, then retry. */
export const PDF_PASSWORD_REQUIRED = 'PDF_PASSWORD_REQUIRED';

export function makePdfPasswordRequiredError(): Error {
  const error = new Error(PDF_PASSWORD_REQUIRED);
  error.name = PDF_PASSWORD_REQUIRED;
  return error;
}

export function isPdfPasswordRequired(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === PDF_PASSWORD_REQUIRED
  );
}
