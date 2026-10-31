import { describe, expect, it } from 'vitest';
import { createAgentDocument, parseAgentDocument } from './index';

describe('createAgentDocument', () => {
  it('is a plain empty document: no v1 snapshot rides on the document or its page', () => {
    const document = createAgentDocument('Checkout', 'doc-1');
    expect(parseAgentDocument(document)).toEqual(document);
    expect(document).toMatchObject({ id: 'doc-1', name: 'Checkout', pages: [{ id: 'doc-1:page-1', name: 'Page 1', nodes: [], connectors: [] }] });
    expect(JSON.stringify(document)).not.toContain('openflowkit.legacy');
  });
});
