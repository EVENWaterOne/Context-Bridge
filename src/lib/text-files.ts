/** Decode before importing; Blob.text() silently replaces invalid bytes. */
export async function readUtf8File(file: Blob): Promise<string> {
  if (file.size > 1024 * 1024) throw new Error('File exceeds the 1 MB text-file limit.');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('This file is not UTF-8. Convert it explicitly before importing.'); }
  if (content.includes('\0')) throw new Error('Binary files cannot be imported as text.');
  return content;
}
