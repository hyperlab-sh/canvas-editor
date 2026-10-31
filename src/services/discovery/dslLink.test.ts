import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeDslPayload, dslLink, encodeDslPayload, MAX_DSL_BYTES, MAX_LINK_PAYLOAD } from './dslLink';

const encode = (text: string) => deflateRawSync(Buffer.from(text, 'utf8')).toString('base64url');

describe('decodeDslPayload', () => {
  it('reads what node deflateRaw + base64url wrote, unicode included', async () => {
    const dsl = 'flow "Café ☕"\n  a -> b\n';
    expect(await decodeDslPayload(encode(dsl))).toBe(dsl);
  });
  it('rejects a missing payload', async () => {
    await expect(decodeDslPayload(null)).rejects.toThrow(/missing/i);
    await expect(decodeDslPayload('')).rejects.toThrow(/missing/i);
  });
  it('rejects bad base64', async () => {
    await expect(decodeDslPayload('***not base64***')).rejects.toThrow(/base64/i);
  });
  it('rejects a bad deflate stream', async () => {
    await expect(decodeDslPayload(Buffer.from('plain text, not deflate').toString('base64url'))).rejects.toThrow(/compressed/i);
  });
  it('rejects output over the cap', async () => {
    await expect(decodeDslPayload(encode('a'.repeat(MAX_DSL_BYTES + 1)))).rejects.toThrow(/too large/i);
  });
});

describe('dslLink', () => {
  it('writes what the decoder and node both read back, unicode included', async () => {
    const dsl = 'flowchart\nCafé ☕ -> "Order: #42"\n';
    const payload = await encodeDslPayload(dsl);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeDslPayload(payload)).toBe(dsl);
    expect(inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8')).toBe(dsl);
  });
  it('builds the link on the app, never on the page it was made from', async () => {
    const link = await dslLink('flowchart\na -> b', 'https://app.openflowkit.com/#/d/doc-1?page=2');
    expect(link).toMatch(/^https:\/\/app\.openflowkit\.com\/#\/from\/dsl\?d=[A-Za-z0-9_-]+$/);
  });
  it('carries the title beside the payload, and a link without one stays valid', async () => {
    const link = await dslLink('flowchart\na -> b', 'https://app.openflowkit.com/', ' Café & Co ');
    const query = new URLSearchParams(link!.split('?')[1]);
    expect(query.get('t')).toBe('Café & Co');
    expect(await decodeDslPayload(query.get('d'))).toBe('flowchart\na -> b');
    expect(await dslLink('flowchart\na -> b', 'https://app.openflowkit.com/', '  ')).not.toContain('&t=');
  });
  it('gives no link when the code would not survive being pasted', async () => {
    // Random-ish text barely compresses: well over the cap once deflated.
    const noisy = Array.from({ length: 60_000 }, (_, index) => ((index * 7919) % 9973).toString(36)).join(' ');
    expect((await encodeDslPayload(noisy)).length).toBeGreaterThan(MAX_LINK_PAYLOAD);
    expect(await dslLink(noisy, 'https://app.openflowkit.com/')).toBeNull();
  });
});
