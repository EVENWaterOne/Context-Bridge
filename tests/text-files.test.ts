import test from 'node:test';
import assert from 'node:assert/strict';
import { readUtf8File } from '../src/lib/text-files.ts';

test('import preserves UTF-8 BOM, Chinese comments and CRLF without silent transcoding', async () => {
  const source = '\ufeff// 舵机\r\nint duration = 6;\r\n';
  assert.equal(await readUtf8File(new Blob([source])), source);
});
test('non-UTF-8, binary and oversized input fail before becoming a task copy', async () => {
  await assert.rejects(readUtf8File(new Blob([new Uint8Array([0xff, 0xfe, 0x81])])), /not UTF-8/);
  await assert.rejects(readUtf8File(new Blob(['header\0binary'])), /Binary/);
  await assert.rejects(readUtf8File(new Blob([new Uint8Array(1024 * 1024 + 1)])), /1 MB/);
});
