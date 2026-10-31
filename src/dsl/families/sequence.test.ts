import { describe, expect, it } from 'vitest';
import { compile } from '../compile';
import { resolveConnectorPresentation } from '../../opencanvas/domain/connectors/presentation';
import { connectorLabelPlate, resolveConnectorLabelStyle } from '../../opencanvas/domain/connectors/labelStyle';
import { format, serialize } from '../serialize';
import { resolveSequenceNodePresentation } from '../../opencanvas/domain/nodes/sequenceNodePresentation';

describe('sequence family', () => {
  it('`id = Label` names exactly that participant, as sender, receiver or note target', async () => {
    const result = await compile('sequence\nparticipant b = a\nparticipant a = Z\na -> b = a : hi\nnote over b = a : here');
    expect(result.diagnostics.filter((item) => item.severity !== 'info')).toEqual([]);
    expect(result.connectors.map((connector) => `${connector.source.nodeId}->${connector.target.nodeId}`)).toEqual(['a->b']);
  });

  it('lays participants out left to right and messages down the timeline', async () => {
    const result = await compile('sequence\nparticipant Alice\nBob\nAlice -> Bob : hi\nBob -->> Alice : there');
    const alice = result.nodes.find((node) => node.id === 'alice')!;
    const bob = result.nodes.find((node) => node.id === 'bob')!;
    expect(alice.kind).toBe('sequence_participant');
    expect(bob.transform.translation.x).toBeGreaterThan(alice.transform.translation.x);
    expect(bob.transform.translation.y).toBe(alice.transform.translation.y);
    const [first, second] = result.connectors;
    expect(first?.semantics).toMatchObject({ seqMessageKind: 'sync', seqMessageOrder: 0 });
    expect(second?.semantics).toMatchObject({ seqMessageKind: 'return', seqMessageOrder: 1 });
    expect(alice.size.height).toBeGreaterThan(200);
  });

  it('draws a message with `[head: cross]` ending in a cross, solid or dashed, and keeps it on a round trip', async () => {
    const text = '%% ofk 1\nsequence\n\nA -> B : lost [head: cross]\nB --> A : lost reply [head: cross]\nA -> B : plain\n';
    const result = await compile(text);
    expect(result.diagnostics.filter((item) => item.severity !== 'info')).toEqual([]);
    const [solid, dashed, plain] = result.connectors.map(resolveConnectorPresentation);
    expect(solid).toMatchObject({ targetMarkers: ['cross'], stroke: { dash: [] } });
    expect(dashed!.targetMarkers).toEqual(['cross']);
    expect(dashed!.stroke.dash.length).toBeGreaterThan(0);
    expect(plain!.targetMarkers).toEqual(['triangle-filled']);
    expect(serialize(result)).toBe(text);
    expect(await format(text)).toBe(text);
  });

  it('marks actors and keeps their header aligned with participants', async () => {
    const result = await compile('sequence\nparticipant Browser [actor]\nAPI\nBrowser -> API : x');
    const browser = result.nodes.find((node) => node.id === 'browser')!;
    const api = result.nodes.find((node) => node.id === 'api')!;
    expect(browser.content.seqParticipantKind).toBe('actor');
    // Actors sit 40px higher so both header bottoms line up (renderer contract).
    expect(browser.transform.translation.y).toBe(0);
    expect(api.transform.translation.y).toBe(40);
  });

  it('records activations against the message order', async () => {
    const result = await compile('sequence\nA -> B : one\nactivate B\nB -> B : two\ndeactivate B');
    const bob = result.nodes.find((node) => node.id === 'b')!;
    expect(bob.content.seqActivations).toMatchObject([{ order: 1, activate: true }, { order: 2, activate: false }]);
  });

  it('nests fragments and keeps branch order', async () => {
    const result = await compile('sequence\nA -> B : pay\nalt ok {\nA -> B : charge\n} else no {\nopt retry {\nA -> B : again\n}\n}');
    const fragments = result.nodes.filter((node) => node.kind === 'annotation');
    expect(fragments.map((node) => node.content.label)).toEqual(['ALT', 'ELSE', 'OPT']);
    expect(fragments.map((node) => (node.metadata.dsl as { seqFragmentBranch?: number }).seqFragmentBranch)).toEqual([0, 1, 0]);
    // The opt sits inside the else branch, so it is parented to it.
    expect((fragments[2]?.metadata.dsl as { seqFragmentParent?: string }).seqFragmentParent).toBe(fragments[1]?.id);
    expect((fragments[1]?.metadata.dsl as { seqFragmentParent?: string }).seqFragmentParent).toBeNull();
    const text = serialize(result);
    expect(text).toContain('} else no {');
    expect(text).toContain('  opt retry {');
    expect(await format(text)).toBe(text);
  });

  // The owner's report, 2026-10-07: two notes sat on top of each other and on the loop below them.
  it('gives every note its own room on the timeline, inside the block it was written in', async () => {
    const result = await compile('sequence\nA -> B : one\nnote right of B : first\nnote over A, B : second\nA -> B : two\nloop again {\n  note over A : inside\n  A -> B : three\n}');
    const notes = result.nodes.filter((node) => node.kind === 'sequence_note');
    const loop = result.nodes.find((node) => node.kind === 'annotation')!;
    // Frame-relative message y: header 48 + actor room 40 + offset 20, then 52 px a row.
    const messageY = result.connectors.map((connector) => 108 + 52 * Number(connector.semantics.seqMessageRow ?? connector.semantics.seqMessageOrder));
    const spans = notes.map((note) => [note.transform.translation.y, note.transform.translation.y + note.size.height] as const);
    for (const [top, bottom] of spans) for (const y of messageY) expect(y > top && y < bottom).toBe(false);
    for (const [index, [top, bottom]] of spans.entries()) {
      for (const [otherTop, otherBottom] of spans.slice(index + 1)) expect(top < otherBottom && otherTop < bottom).toBe(false);
    }
    // `inside` was written in the loop: the loop's band starts above it; `second` was written before it.
    expect(loop.transform.translation.y).toBeLessThan(spans[2]![0]);
    expect(loop.transform.translation.y).toBeGreaterThanOrEqual(spans[1]![1]);
    // Orders stay message indices, so the text round-trips; only rows move.
    expect(result.connectors.map((connector) => connector.semantics.seqMessageOrder)).toEqual([0, 1, 2]);
    expect(await format(serialize(result))).toBe(serialize(result));
  });

  // Found 2026-10-07: the home "Request lifecycle" starter wrote Mermaid's `alt x … else y … end`;
  // with no warning, `end` and the words after a `{` in a label became three participants.
  it('warns on a Mermaid-style block instead of reading its words as participants', async () => {
    const result = await compile('sequence\nparticipant A\nparticipant B\nalt ok\n  A -> B : yes\nelse no\n  A -> B : nope\nend');
    expect(result.diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message)).toEqual([
      'alt needs a { … } block', 'else needs a { … } block', '`end` closes nothing: a block closes with }',
    ]);
    expect(result.nodes.filter((node) => node.kind === 'sequence_participant').map((node) => node.content.label)).toEqual(['A', 'B']);
    expect(result.connectors).toHaveLength(2);
  });

  it('places notes relative to their targets', async () => {
    const result = await compile('sequence\nA\nB\nnote over A, B : shared\nnote right of B : hint\nnote left of A : aside');
    const [over, right, left] = result.nodes.filter((node) => node.kind === 'sequence_note');
    expect(over?.content).toMatchObject({ seqNotePosition: 'over', seqNoteTargets: ['a', 'b'] });
    expect(right?.transform.translation.x).toBeGreaterThan(0);
    expect(left).toBeDefined();
  });

  it('warns about unknown participants and malformed statements', async () => {
    const result = await compile('sequence\nactivate Ghost\nelse x {\nloop every 5s {\nA -> B : ok');
    const codes = result.diagnostics.map((item) => item.code);
    expect(codes).toContain('W150');
    expect(codes).toContain('W101');
    expect(codes).toContain('W103');
    expect(result.connectors).toHaveLength(1);
  });

  it('treats a bare word as a participant and rejects broken messages', async () => {
    const declared = await compile('sequence\nAlpha\nBeta');
    expect(declared.nodes.map((node) => node.id)).toEqual(['alpha', 'beta']);
    const broken = await compile('sequence\nAlpha -> : no receiver');
    expect(broken.diagnostics.map((item) => item.code)).toContain('W101');
  });
  it('keeps participants whose names slug alike apart (CJK, Arabic, emoji)', async () => {
    const result = await compile('sequence\n用户 -> 服务 : 请求\nخادم -> 😀 : hi');
    expect(result.nodes.filter((node) => node.kind !== 'text').map((node) => node.content.label)).toEqual(expect.arrayContaining(['用户', '服务', 'خادم', '😀']));
    const ends = (scene: typeof result) => scene.connectors.map((connector) => `${connector.source.nodeId}->${connector.target.nodeId}`);
    expect(new Set(ends(result).flatMap((end) => end.split('->'))).size).toBe(4);
    expect(ends(await compile(serialize(result)))).toEqual(ends(result));
  });

  it('refuses a message chain or fan with W112 instead of naming a participant after it', async () => {
    for (const line of ['A ->> B ->> C', 'A -> B -> C : x', 'A -> B, C']) {
      const result = await compile(`sequence\n${line}`);
      expect(result.diagnostics.filter((item) => item.severity !== 'info').map((item) => item.code)).toEqual(['W112']);
      expect(result.connectors).toHaveLength(0);
    }
  });

  // Persona U2 (2026-10-11), a payment-authorization review: alt and else drew as two boxes, the
  // else ran on under the opt below it, its note straddled the else/opt border, the Gateway bar
  // ran into the opt past its `deactivate`, and the actor's figure struck through the title.
  describe('payment authorization (persona U2)', () => {
    const payment = 'sequence\ntitle: Card payment authorization\nparticipant Shopper [actor]\nparticipant Checkout\nparticipant Gateway = Payments API\n'
      + 'participant Risk = Fraud service\nparticipant Issuer = Card network / Issuer [queue]\nparticipant Ledger [db]\n'
      + 'Shopper -> Checkout : Pay $42.00\nCheckout -> Gateway : POST /authorize (idempotency-key)\nactivate Gateway\n'
      + 'Gateway -> Gateway : validate + dedupe\nGateway -> Risk : score(txn)\nRisk --> Gateway : score 0.12\n'
      + 'alt score < 0.8 {\n  Gateway -> Issuer : ISO 8583 auth request\n  Issuer --> Gateway : approved (auth code)\n'
      + '  Gateway -> Ledger : write PENDING hold\n  Gateway --> Checkout : 201 authorized\n} else declined by risk {\n'
      + '  Gateway --> Checkout : 402 declined\n  note right of Risk : decision logged for model retraining\n}\ndeactivate Gateway\n'
      + 'opt 3-D Secure required {\n  Checkout -> Shopper : challenge\n  Shopper --> Checkout : OTP\n}\n'
      + 'note over Checkout, Gateway : retries reuse the same idempotency key\nGateway -->> Risk : AuthorizationCompleted (async)';
    const span = (node: { transform: { translation: { y: number } }; size: { height: number } }) => (
      { top: node.transform.translation.y, bottom: node.transform.translation.y + node.size.height });

    it('draws alt … else as one frame with a divider, and stacks the opt below it', async () => {
      const result = await compile(payment);
      const [alt, otherwise, opt] = result.nodes.filter((node) => node.kind === 'annotation');
      expect([alt, otherwise, opt].map((node) => node!.content.label)).toEqual(['ALT', 'ELSE', 'OPT']);
      // The else continues the alt's frame: a divider where the alt branch ends, not a second box.
      expect(alt!.content).toMatchObject({ seqFragmentContinued: true });
      expect(otherwise!.content).toMatchObject({ seqFragmentDivider: true });
      expect(opt!.content.seqFragmentDivider).toBeUndefined();
      expect(span(otherwise!).top).toBe(span(alt!).bottom);
      expect(span(otherwise!).bottom).toBeLessThan(span(opt!).top);
    });

    it('keeps a note written in the else inside the else', async () => {
      const result = await compile(payment);
      const [, otherwise, opt] = result.nodes.filter((node) => node.kind === 'annotation');
      const note = result.nodes.find((node) => node.content.label === 'decision logged for model retraining')!;
      expect(span(note).top).toBeGreaterThanOrEqual(span(otherwise!).top + 24);
      expect(span(note).bottom).toBeLessThan(span(otherwise!).bottom);
      expect(span(note).bottom).toBeLessThan(span(opt!).top);
    });

    it('ends an activation where its `deactivate` is written, not at the next message', async () => {
      const result = await compile(payment);
      const gateway = result.nodes.find((node) => node.id === 'Gateway')!;
      const opt = result.nodes.filter((node) => node.kind === 'annotation')[2]!;
      const [bar] = (resolveSequenceNodePresentation(gateway) as unknown as { activations: Array<{ startOrder: number; endOrder: number }> }).activations;
      // A row's line: the lane's header bottom, then the message offset, then 52 px a row.
      const lineY = (row: number) => gateway.transform.translation.y + 48 + 44 + row * 52;
      expect(lineY(bar!.endOrder)).toBeLessThanOrEqual(span(opt).top);
      const declined = result.connectors.find((connector) => connector.labels[0]?.text === '402 declined')!;
      expect(bar!.endOrder).toBeGreaterThan(Number(declined.semantics.seqMessageRow));
    });

    it('keeps the actor figure below the title and every header bottom level', async () => {
      const result = await compile(payment);
      const lanes = result.nodes.filter((node) => node.kind === 'sequence_participant');
      const shopper = lanes.find((node) => node.content.label === 'Shopper')!;
      // The frame's title band is the top 40 px; the figure starts under it.
      expect(shopper.transform.translation.y).toBeGreaterThanOrEqual(40);
      const headerBottom = (node: typeof shopper) => node.transform.translation.y + (node.content.seqParticipantKind === 'actor' ? 40 : 0) + 48;
      expect(new Set(lanes.map(headerBottom)).size).toBe(1);
    });

    it('gives [db] and [queue] participants their head shape', async () => {
      const result = await compile(payment);
      const head = (id: string) => (resolveSequenceNodePresentation(result.nodes.find((node) => node.id === id)!) as unknown as { head?: string }).head;
      expect([head('ledger'), head('Issuer'), head('checkout')]).toEqual(['cylinder', 'queue', 'box']);
      expect(serialize(result)).toContain('participant Ledger [db]');
    });

    it('round-trips the text with every block, note and activation', async () => {
      const text = await format(payment);
      expect(await format(text)).toBe(text);
      expect(text).toContain('} else declined by risk {');
      expect(text).toContain('activate Gateway');
      expect(text).toContain('deactivate Gateway');
      // The note written in the else stays there; it does not move into the opt that follows.
      expect(text).toMatch(/402 declined\n {2}note right of Risk[^\n]*\n\}\ndeactivate Gateway[^\n]*\nopt/);
    });
  });

  // Review of the U2 lane, 2026-10-11.
  describe('blocks, bars and names (review)', () => {
    const span = (node: { transform: { translation: { y: number } }; size: { height: number } }) => (
      { top: node.transform.translation.y, bottom: node.transform.translation.y + node.size.height });

    it('keeps an else inside another block: one frame, inside its parent, holding its messages', async () => {
      const text = 'sequence\nA -> B : one\nloop l {\n  alt a {\n    A -> B : x\n  } else {\n    B -> A : y\n    note over A, B : end of else\n  }\n}\nA -> B : after';
      const result = await compile(text);
      expect(result.diagnostics.filter((item) => item.severity !== 'info')).toEqual([]);
      const [loop, alt, otherwise] = result.nodes.filter((node) => node.kind === 'annotation');
      expect([loop, alt, otherwise].map((node) => node!.content.label)).toEqual(['LOOP', 'ALT', 'ELSE']);
      expect((otherwise!.metadata.dsl as { seqFragmentParent?: string }).seqFragmentParent).toBe(loop!.id);
      expect(span(otherwise!).top).toBe(span(alt!).bottom);
      expect(span(alt!).top).toBeGreaterThanOrEqual(span(loop!).top + 24);
      expect(span(otherwise!).bottom).toBeLessThan(span(loop!).bottom);
      const lineY = (label: string) => {
        const connector = result.connectors.find((item) => item.labels[0]?.text === label)!;
        return 132 + Number(connector.semantics.seqMessageRow ?? connector.semantics.seqMessageOrder) * 52;
      };
      expect(lineY('y')).toBeGreaterThan(span(otherwise!).top + 24);
      expect(lineY('y')).toBeLessThan(span(otherwise!).bottom);
      const note = result.nodes.find((node) => node.kind === 'sequence_note')!;
      expect(span(note).top).toBeGreaterThan(span(otherwise!).top);
      expect(span(note).bottom).toBeLessThan(span(otherwise!).bottom);
      expect(lineY('after')).toBeGreaterThan(span(loop!).bottom);
      const once = await format(text);
      expect(once).toContain('  } else {\n    B -> A : y\n    note over A, B : end of else\n  }\n}');
      expect(await format(once)).toBe(once);
    });

    it('ends a bar where `deactivate` is written, even after one message', async () => {
      const result = await compile('sequence\nA -> B : x\nloop l {\n  activate B\n  B -> C : y\n  deactivate B\n}\nopt o {\n  C -> B : z\n}');
      const b = result.nodes.find((node) => node.id === 'b')!;
      const opt = result.nodes.find((node) => node.content.label === 'OPT')!;
      const [bar] = (resolveSequenceNodePresentation(b) as unknown as { activations: Array<{ endOrder: number }> }).activations;
      expect(b.transform.translation.y + 48 + 44 + bar!.endOrder * 52).toBeLessThanOrEqual(span(opt).top);
    });

    it('reads a quoted name holding `=` as that participant in activate and note', async () => {
      const result = await compile('sequence\n"a=b" -> B : x\nactivate "a=b"\nnote over "a=b", B : n\nB -> "a=b" : y\ndeactivate "a=b"');
      expect(result.diagnostics.filter((item) => item.severity !== 'info')).toEqual([]);
      const participant = result.nodes.find((node) => node.content.label === 'a=b')!;
      expect(participant.content.seqActivations).toHaveLength(2);
      expect(result.nodes.find((node) => node.kind === 'sequence_note')!.content.seqNoteTargets).toEqual([participant.id, 'b']);
    });

    it('writes a saved bar with no source line before the message it was written above', async () => {
      const result = await compile('sequence\nA -> B : one\nactivate B\nB -> C : two\nC --> B : three\ndeactivate B\nB --> A : four');
      const scene = { frame: result.frame, nodes: result.nodes, groups: result.groups, connectors: result.connectors };
      const saved = {
        ...scene,
        nodes: result.nodes.map((node) => (Array.isArray(node.content.seqActivations) ? {
          ...node, content: { ...node.content, seqActivations: (node.content.seqActivations as Array<Record<string, unknown>>).map(({ line: _line, ...rest }) => rest) },
        } : node)) as typeof result.nodes,
      };
      expect(serialize(saved as never)).toBe(serialize(scene));
    });
  });

  describe('readable layout', () => {
    const login = 'sequence\nparticipant Browser\nparticipant API Gateway\nparticipant Auth Service\nparticipant Database\n'
      + 'Browser -> API Gateway : POST /login (email, password)\nAPI Gateway -> Auth Service : validate credentials\n'
      + 'Auth Service -> Database : SELECT user by email\nDatabase --> Auth Service : user record\n'
      + 'alt password matches {\n  Auth Service -> Database : create session\n  API Gateway --> Browser : 200 OK + session cookie\n'
      + '} else mismatch {\n  Auth Service --> API Gateway : 401 invalid credentials\n  API Gateway --> Browser : 401 Unauthorized\n}';
    const center = (node: { transform: { translation: { x: number } }; size: { width: number } }) => node.transform.translation.x + node.size.width / 2;

    it('lifts a label above its arrow so the plate never covers the line', async () => {
      const result = await compile(login);
      const style = resolveConnectorLabelStyle(result.connectors[0]!);
      for (const connector of result.connectors) {
        const label = connector.labels[0]!;
        const plate = connectorLabelPlate(label.text, style, { x: 0, y: label.offset.y });
        expect(plate.y + plate.height).toBeLessThan(0);
      }
    });

    // Persona P03: an alt's top edge ran into its first arrow; a loop's label sat on the block edge above it.
    // Persona P06 (Request lifecycle starter): the ALT border struck through the ELSE guard and the reply below.
    it.each([
      ['mixed blocks', 'sequence\nBrowser -> CDN : HTTPS\nalt cached {\n  CDN -> API : GET /me\n  API --> CDN : 200\n} else miss {\n  CDN -> Origin : fetch\n}\n'
        + 'loop every 30s {\n  Browser -> API : heartbeat\n}\nopt retry {\n  loop backoff {\n    API -> Origin : ping\n  }\n}\nBrowser -> CDN : done'],
      ['request lifecycle', 'sequence\nparticipant Browser\nparticipant Gateway\nparticipant Service\nBrowser -> Gateway : POST /orders\nGateway -> Service : order.create\n'
        + 'alt accepted {\n  Service --> Gateway : "202 {orderId}"\n} else rejected {\n  Service --> Gateway : "409 {reason}"\n}\nGateway --> Browser : response'],
      ['empty branch', 'sequence\nA -> B : one\nalt yes {\n} else no {\n  B --> A : two\n}\nA -> B : three'],
    ])('keeps every fragment edge and header clear of every message label and arrow: %s', async (_name, source) => {
      const result = await compile(source);
      const style = resolveConnectorLabelStyle(result.connectors[0]!);
      const bands = result.connectors.map((connector) => {
        const lineY = 132 + Number(connector.semantics.seqMessageRow ?? connector.semantics.seqMessageOrder) * 52;
        const plate = connectorLabelPlate(connector.labels[0]!.text, style, { x: 0, y: connector.labels[0]!.offset.y });
        return { text: connector.labels[0]!.text, top: lineY + plate.y, bottom: lineY + 2 };
      });
      const overlaps: string[] = [];
      for (const fragment of result.nodes.filter((node) => node.kind === 'annotation')) {
        const top = fragment.transform.translation.y;
        const edges = [{ name: 'header', from: top, to: top + 24 }, { name: 'bottom', from: top + fragment.size.height - 1, to: top + fragment.size.height + 1 }];
        for (const edge of edges) {
          for (const band of bands) if (edge.from < band.bottom && edge.to > band.top) overlaps.push(`${fragment.id} ${edge.name} / ${band.text}`);
        }
        // No other block's border crosses this header (its tag and guard text).
        for (const other of result.nodes.filter((node) => node.kind === 'annotation' && node !== fragment)) {
          const bottom = other.transform.translation.y + other.size.height;
          if (bottom > top + 1 && bottom < top + 24) overlaps.push(`${other.id} bottom / ${fragment.id} header`);
        }
      }
      const headers = result.nodes.filter((node) => node.kind === 'annotation').map((node) => node.transform.translation.y).sort((a, b) => a - b);
      for (let index = 1; index < headers.length; index += 1) if (headers[index]! - headers[index - 1]! < 24) overlaps.push(`headers at ${headers[index - 1]} and ${headers[index]}`);
      expect(overlaps).toEqual([]);
    });

    it('keeps a fragment header above the label of its first message', async () => {
      const result = await compile(login);
      const style = resolveConnectorLabelStyle(result.connectors[0]!);
      const rowTop = (index: number) => Number(result.connectors[index]!.semantics.seqMessageRow ?? result.connectors[index]!.semantics.seqMessageOrder) * 52;
      for (const fragment of result.nodes.filter((node) => node.kind === 'annotation')) {
        const first = result.connectors[Number(fragment.content.seqMessageOrder)]!;
        const plate = connectorLabelPlate(first.labels[0]!.text, style, { x: 0, y: first.labels[0]!.offset.y });
        const lineY = 132 + rowTop(Number(fragment.content.seqMessageOrder));
        // The 24px header tag ends above the first message's label plate.
        expect(fragment.transform.translation.y + 24).toBeLessThanOrEqual(lineY + plate.y);
      }
    });

    it('puts the guard text clear of every lifeline', async () => {
      const result = await compile(login);
      const lifelines = result.nodes.filter((node) => node.kind === 'sequence_participant').map(center);
      for (const fragment of result.nodes.filter((node) => node.kind === 'annotation')) {
        const guard = fragment.content.seqGuard as { x: number; width: number };
        const left = fragment.transform.translation.x + guard.x;
        for (const lifeline of lifelines) expect(lifeline <= left || lifeline >= left + guard.width).toBe(true);
      }
    });
  });
});
