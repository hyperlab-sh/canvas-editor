import { describe, expect, it } from 'vitest';
import {
  animateBlockFromTimeline, animateBlockLines, animateFromJson, animateToJson, extractAnimateBlock,
  formatAnimateDuration, motionTimelineFor, parseAnimateDuration, timelineFromAnimate, writeAnimateBlock,
} from './animate';
import { compile } from './compile';
import { parseDocument } from './document';
import { serialize } from './serialize';
import { animEdge, animNode, animPage } from '../opencanvas/domain/animation/testFixtures';
import type { SceneDocumentV1 } from '../opencanvas/domain/document/types';

const BLOCK = `%% ofk 1
flowchart

a -> b
b -> c

animate build 6s loop {
  step a, b
  step b -> c : POST
  step c hold 2s
}
`;

describe('animate block', () => {
  it('parses the header and every step form', () => {
    const document = parseDocument(BLOCK);
    const { block, segments } = extractAnimateBlock(document.segments, []);
    expect(block).toEqual({
      preset: 'build',
      durationMs: 6000,
      loop: true,
      steps: [
        { refs: ['a', 'b'], line: 8 },
        { refs: [], edges: [['b', 'c']], label: 'POST', line: 9 },
        { refs: ['c'], holdMs: 2000, line: 10 },
      ],
    });
    // The block never reaches the family parser.
    expect(segments.some((segment) => segment.tokens[0]?.value === 'animate')).toBe(false);
  });

  it('round-trips: parse(serialize) is byte-identical and idempotent', async () => {
    const compiled = await compile(BLOCK);
    const scene = { frame: compiled.frame, nodes: compiled.nodes, groups: compiled.groups, connectors: compiled.connectors };
    const once = serialize(scene);
    expect(once).toBe(BLOCK);
    const again = await compile(once);
    expect(serialize({ frame: again.frame, nodes: again.nodes, groups: again.groups, connectors: again.connectors })).toBe(once);
  });

  it('serializes a block without inventing one', async () => {
    const compiled = await compile('flowchart\na -> b\n');
    const scene = { frame: compiled.frame, nodes: compiled.nodes, groups: compiled.groups, connectors: compiled.connectors };
    expect(serialize(scene)).not.toContain('animate');
  });

  it('warns on unknown presets and keeps going', () => {
    const diagnostics: import('./ast').DslDiagnostic[] = [];
    const document = parseDocument('flowchart\nanimate zoom 10s {\n  step a\n}\n');
    const { block } = extractAnimateBlock(document.segments, diagnostics);
    expect(block?.preset).toBe('build');
    expect(diagnostics.some((item) => item.code === 'W190' && item.message.includes('zoom'))).toBe(true);
  });

  it('warns and closes an unclosed block', () => {
    const diagnostics: import('./ast').DslDiagnostic[] = [];
    const document = parseDocument('flowchart\nanimate build {\n  step a\n');
    const { block } = extractAnimateBlock(document.segments, diagnostics);
    expect(block?.steps).toEqual([{ refs: ['a'], line: 3 }]);
    expect(diagnostics.some((item) => item.code === 'W103')).toBe(true);
  });

  it('reads durations and formats them back', () => {
    expect(parseAnimateDuration('10s')).toBe(10_000);
    expect(parseAnimateDuration('8500ms')).toBe(8500);
    expect(parseAnimateDuration('2')).toBe(2000);
    expect(parseAnimateDuration('soon')).toBeNull();
    expect(parseAnimateDuration('0')).toBeNull();
    expect(formatAnimateDuration(10_000)).toBe('10s');
    expect(formatAnimateDuration(8500)).toBe('8500ms');
  });

  it('survives malformed metadata', () => {
    expect(animateFromJson(null)).toBeNull();
    expect(animateFromJson({ preset: 'zoom', steps: [{ refs: ['a'] }] })?.preset).toBe('build');
    expect(animateFromJson({ steps: [{ refs: [] }, { refs: ['a'], holdMs: -5 }] })?.steps)
      .toEqual([{ refs: ['a'] }]);
  });

  it('resolves refs to scene ids and cameras, warning on unknown nodes', () => {
    const page = animPage(
      [animNode('a', 0, 0), animNode('b', 0, 100)],
      [animEdge('ab', 'a', 'b')],
    );
    const diagnostics: import('./ast').DslDiagnostic[] = [];
    const block = {
      preset: 'build' as const, loop: false,
      steps: [
        { refs: ['a', 'b'] },
        { refs: ['a'], edges: [['a', 'b']] as [string, string][], label: 'POST' },
        { refs: ['ghost'] },
      ],
    };
    const timeline = timelineFromAnimate(page, block, diagnostics);
    expect(timeline.preset).toBe('build');
    expect(timeline.steps[0]).toMatchObject({ nodeIds: ['a', 'b'] });
    expect(timeline.steps[1]?.connectorIds).toEqual(['ab']);
    expect(timeline.steps[1]?.note).toBe('POST');
    expect(timeline.steps[0]?.camera).toMatchObject({ x: 0, y: 0 });
    expect(timeline.steps[2]?.nodeIds).toEqual([]);
    expect(diagnostics.some((item) => item.code === 'W122')).toBe(true);
    expect(timeline.durationMs).toBe(2 * 1700 + 2600);
  });

  // README animation, 2026-10-11: arrows no step named were drawn from frame 0, floating before their boxes.
  it('reveals an unnamed connector with the later of its two endpoints', () => {
    const page = animPage(
      [animNode('a', 0, 0), animNode('b', 0, 100), animNode('c', 0, 200), animNode('d', 0, 300)],
      [animEdge('ab', 'a', 'b'), animEdge('bc', 'b', 'c'), animEdge('cd', 'c', 'd')],
    );
    const timeline = timelineFromAnimate(page, {
      preset: 'build', loop: false,
      steps: [{ refs: ['a'] }, { refs: ['b'], edges: [['a', 'b']] as [string, string][] }, { refs: ['c'] }],
    });
    // `d` is never named, so it is on screen throughout; `cd` appears with `c`, its later end.
    expect(timeline.steps.map((step) => step.connectorIds)).toEqual([[], ['ab'], ['bc', 'cd']]);
  });

  it('honours a header duration by scaling the clip', () => {
    const page = animPage([animNode('a', 0, 0), animNode('b', 0, 100)]);
    const timeline = timelineFromAnimate(page, {
      preset: 'pulse', loop: true, durationMs: 4000, steps: [{ refs: ['a'] }, { refs: ['b'] }],
    });
    expect(timeline.loop).toBe(true);
    expect(timeline.durationMs).toBe(4000);
  });

  it('round-trips the JSON form', () => {
    const block = {
      preset: 'walkthrough' as const, loop: true, durationMs: 5000,
      steps: [{ refs: ['a'], holdMs: 900 }, { refs: ['b'], edges: [['a', 'b']] as [string, string][], label: 'POST' }],
    };
    expect(animateFromJson(animateToJson(block))).toEqual(block);
  });

  it('emits the canonical block text', () => {
    expect(animateBlockLines({
      preset: 'build', durationMs: 6000, loop: true,
      steps: [{ refs: ['a', 'b'] }, { refs: [], edges: [['b', 'c']] as [string, string][], label: 'POST' }, { refs: ['c'], holdMs: 2000 }],
    })).toEqual([
      'animate build 6s loop {',
      '  step a, b',
      '  step b -> c : POST',
      '  step c hold 2s',
      '}',
    ]);
  });

  // Orchestrator 2026-10-11: `step Browser` animated nothing (the id is `browser`), `step "API Gateway"`
  // needed `api-gateway`, and the W122 that should have said so never reached validate.
  it('resolves a step ref the way an edge does — as written, by label or by slug — and warns at compile on the rest', async () => {
    const compiled = await compile('flowchart\nBrowser -> API Gateway\nLedger DB = Aurora\nAPI Gateway -> Ledger DB\n\nanimate build {\n'
      + '  step Browser\n  step "API Gateway", Aurora\n  step Browser -> API Gateway\n  step api-gateway -> Ledger DB\n  step Ghost\n}\n');
    const page = { id: 'p', name: 'P', layers: [], nodes: [compiled.frame, ...compiled.nodes], connectors: compiled.connectors, metadata: {}, extensions: {} } as unknown as Parameters<typeof timelineFromAnimate>[0];
    const block = animateFromJson((compiled.frame.metadata.dsl as { animate: unknown }).animate)!;
    const timeline = timelineFromAnimate(page, block);
    expect(timeline.steps.map((step) => step.nodeIds)).toEqual([['browser'], ['api-gateway', 'ledger-db'], ['browser', 'api-gateway'], ['api-gateway', 'ledger-db'], []]);
    expect(timeline.steps.map((step) => step.connectorIds.length)).toEqual([0, 0, 1, 1, 0]);
    expect(compiled.diagnostics.filter((item) => item.code === 'W122').map((item) => [item.line, item.message])).toEqual([[11, 'animate: unknown node "Ghost"']]);
  });

  it('never reveals the frame for a step that names the title, nor a CJK node for an unknown CJK ref', async () => {
    const titled = await compile('flowchart\ntitle: Checkout\nco = Checkout\nco -> Pay\n\nanimate build {\n  step Checkout\n}\n');
    const page = (scene: typeof titled) => ({ id: 'p', name: 'P', layers: [], nodes: [scene.frame, ...scene.nodes], connectors: scene.connectors, metadata: {}, extensions: {} }) as unknown as Parameters<typeof timelineFromAnimate>[0];
    const blockOf = (scene: typeof titled) => animateFromJson((scene.frame.metadata.dsl as { animate: unknown }).animate)!;
    expect(timelineFromAnimate(page(titled), blockOf(titled)).steps[0]!.nodeIds).toEqual(['co']);
    const cjk = await compile('flowchart\n数据库 -> 服务\n\nanimate build {\n  step 缓存\n}\n');
    expect(timelineFromAnimate(page(cjk), blockOf(cjk)).steps[0]!.nodeIds).toEqual([]);
    expect(cjk.diagnostics.filter((item) => item.code === 'W122').map((item) => item.message)).toEqual(['animate: unknown node "缓存"']);
  });

  it('works in a non-graph family too', async () => {
    const compiled = await compile('sequence\na -> b : hi\n\nanimate pulse {\n  step a\n}\n');
    expect(compiled.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const scene = { frame: compiled.frame, nodes: compiled.nodes, groups: compiled.groups, connectors: compiled.connectors };
    expect(serialize(scene)).toContain('animate pulse {');
    expect(compiled.nodes.length).toBeGreaterThan(0);
  });
});

describe('timeline → animate block', () => {
  const page = animPage(
    [animNode('a', 0, 0), animNode('b', 0, 100), animNode('c', 0, 200)],
    [animEdge('ab', 'a', 'b'), animEdge('bc', 'b', 'c')],
  );

  it('writes steps, edges, notes and holds', () => {
    const block = animateBlockFromTimeline({
      preset: 'walkthrough', loop: true, durationMs: 0,
      steps: [
        { nodeIds: ['a', 'b'], connectorIds: [] },
        { nodeIds: [], connectorIds: ['ab'], note: 'POST', holdMs: 900 },
      ],
    }, page);
    expect(block.steps).toEqual([
      { refs: ['a', 'b'] },
      { refs: [], edges: [['a', 'b']], label: 'POST', holdMs: 900 },
    ]);
    expect(animateBlockLines(block)).toEqual([
      'animate walkthrough loop {',
      '  step a, b',
      '  step a -> b : POST hold 900ms',
      '}',
    ]);
  });

  it('omits a natural duration and keeps an explicit one', () => {
    const steps = [{ nodeIds: ['a'], connectorIds: [] }];
    const natural = animateBlockFromTimeline({ preset: 'build', loop: false, durationMs: 1700, steps }, page);
    expect(natural.durationMs).toBeUndefined();
    const explicit = animateBlockFromTimeline({ preset: 'build', loop: false, durationMs: 6000, steps }, page);
    expect(explicit.durationMs).toBe(6000);
  });

  it('writes the block into a document idempotently', () => {
    const block = animateBlockFromTimeline({
      preset: 'build', loop: false, durationMs: 0,
      steps: [{ nodeIds: ['a'], connectorIds: [] }],
    }, page);
    const once = writeAnimateBlock('%% ofk 1\nflowchart\n\na -> b\n', block);
    expect(once).toContain('animate build {');
    expect(writeAnimateBlock(once, block)).toBe(once);
    // An existing block is replaced, not duplicated.
    const twice = writeAnimateBlock(once, { ...block, preset: 'pulse' });
    expect(twice.match(/animate /g)).toHaveLength(1);
    expect(twice).toContain('animate pulse {');
    // And it still parses.
    const document = parseDocument(twice);
    expect(extractAnimateBlock(document.segments, []).block?.preset).toBe('pulse');
  });
});

describe('motionTimelineFor', () => {
  it('defaults to autoSequence and reads a code block on request', async () => {
    const compiled = await compile('%% ofk 1\nflowchart\na -> b\nb -> c\n\nanimate pulse 4s {\n  step a\n  step b\n}\n');
    const document: SceneDocumentV1 = {
      format: 'openflowkit.scene', schemaVersion: 1, id: 'x', name: 'x',
      createdAt: '', updatedAt: '', metadata: {}, extensions: {},
      pages: [{
        id: 'p', name: 'P', diagramKind: 'flowchart',
        layers: [{ id: 'default', name: 'L', visible: true, locked: false }],
        nodes: [compiled.frame, ...compiled.groups, ...compiled.nodes], connectors: compiled.connectors,
        metadata: {}, extensions: {},
      }],
    };
    const auto = motionTimelineFor({ document, pageId: 'p' });
    expect(auto.preset).toBe('build');
    expect(auto.steps.length).toBe(3);
    const code = motionTimelineFor({ document, pageId: 'p', order: 'code' });
    expect(code.preset).toBe('pulse');
    expect(code.steps.map((step) => step.nodeIds)).toEqual([['a'], ['b']]);
    expect(code.durationMs).toBe(4000);
    expect(motionTimelineFor({ document, pageId: 'p', durationMs: 10_000 }).durationMs).toBe(10_000);
    expect(() => motionTimelineFor({ document: { ...document, pages: [] }, pageId: 'p' })).toThrow(RangeError);
  });
});
