// The card's page (src/viewer/viewer.html), run in jsdom against a scripted MCP Apps host: the shipped file, not a copy.
// jsdom has no layout, canvas or image decoding, so sizes and the PNG are stubbed; what is tested is the protocol and the DOM.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../src/viewer/viewer.html', import.meta.url), 'utf8');
const EVERY_MS = 250;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Message = { jsonrpc: '2.0'; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
const channels: BroadcastChannel[] = [];
const doms: JSDOM[] = [];

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  for (const dom of doms.splice(0)) dom.window.close();
});

/** One card in a scripted host. `capabilities` is what the host answers to ui/initialize. */
async function mount(capabilities: Record<string, unknown> = { serverTools: {} }, context: Record<string, unknown> = {}) {
  const host = new JSDOM('').window;
  const sent: Message[] = [];
  (host as unknown as { postMessage: (message: Message) => void }).postMessage = (message) => sent.push(message);
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'parent', { get: () => host, configurable: true });
      // Node's BroadcastChannel reaches every card in this process, like cards of one connector in one conversation.
      (window as unknown as { BroadcastChannel: unknown }).BroadcastChannel = class extends BroadcastChannel {
        constructor(name: string) { super(name); channels.push(this); }
      };
      const canvas = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
      canvas.getContext = () => ({ drawImage: () => undefined });
      canvas.toDataURL = () => 'data:image/png;base64,UE5H';
    },
  });
  doms.push(dom);
  const { window } = dom;
  const send = (message: Omit<Message, 'jsonrpc'>) =>
    window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: host as never }));
  const calls = (method: string) => sent.filter((message) => message.method === method);
  send({ id: calls('ui/initialize')[0]!.id!, result: { hostCapabilities: capabilities, hostContext: context } });
  await wait(0);
  const $ = (id: string) => window.document.getElementById(id)!;
  /** Answers the newest unanswered tools/call. */
  const answer = (result: unknown) => {
    const call = calls('tools/call').at(-1)!;
    send({ id: call.id!, result });
    return call;
  };
  const partial = (args: Record<string, unknown>) => send({ method: 'ui/notifications/tool-input-partial', params: { arguments: args } });
  const result = (structuredContent: Record<string, unknown>) => send({ method: 'ui/notifications/tool-result', params: { structuredContent } });
  /** The final picture "loads" (jsdom decodes no images). */
  const loaded = (width = 800, height = 600) => {
    const img = $('img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
    img.dispatchEvent(new window.Event('load'));
  };
  return { window, $, sent, calls, send, answer, partial, result, loaded };
}

const node = (id: string, label = id) => `<g data-node-id="${id}" transform="matrix(1 0 0 1 0 0)"><rect width="120" height="52"/><text>${label}</text></g>`;
const edge = (id: string) => `<g data-connector-id="${id}"><path d="M0 0 L10 10"/><path d="M5 5 L10 10"/></g>`;
const svg = (...parts: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200"><rect width="300" height="200" fill="#fff"/>${node('frame')}${parts.join('')}</svg>`;
const preview = (nodes: number, connectors: number, ...parts: string[]) => ({ structuredContent: { svg: svg(...parts), nodes, connectors } });
const CARD = { title: 'Checkout', svg: svg(node('a'), node('b')), dsl: 'A -> B', nodes: 2, connectors: 1, openUrl: 'https://app.test/#/from/dsl?d=abc', diagnostics: [], losses: [] };

describe('viewer: drawing while the model writes', () => {
  it('previews only complete lines, once per debounce window', async () => {
    const card = await mount();
    card.partial({ source: 'flowchart\nCart -> Pay\nPay -> Do' });
    card.partial({ source: 'flowchart\nCart -> Pay\nPay -> Don' });
    card.partial({ source: 'flowchart\nCart -> Pay\nPay -> Done' });
    expect(card.calls('tools/call')).toHaveLength(0);
    await wait(EVERY_MS + 100);
    const calls = card.calls('tools/call');
    expect(calls).toHaveLength(1);
    // The cut-off last line ("Pay -> Do…") is never sent.
    expect(calls[0]!.params).toEqual({ name: 'preview_diagram', arguments: { source: 'flowchart\nCart -> Pay', theme: 'light' } });
    // Nothing new is complete: no new call.
    card.partial({ source: 'flowchart\nCart -> Pay\nPay -> Done!' });
    await wait(EVERY_MS + 100);
    expect(card.calls('tools/call')).toHaveLength(1);
  });

  it('reads the local tools\' `dsl` argument and the theme, and skips a source with no complete line', async () => {
    const card = await mount();
    card.partial({ dsl: 'flowchart' });
    await wait(EVERY_MS + 100);
    expect(card.calls('tools/call')).toHaveLength(0);
    card.partial({ dsl: 'flowchart\nA -> B\n', theme: 'dark' });
    await wait(EVERY_MS + 100);
    expect(card.calls('tools/call')[0]!.params).toMatchObject({ arguments: { source: 'flowchart\nA -> B', theme: 'dark' } });
  });

  it('keeps previewing while lines keep arriving faster than the window (no starved debounce)', async () => {
    const card = await mount();
    const lines = ['flowchart', 'A -> B', 'B -> C', 'C -> D', 'D -> E', 'E -> F', 'F -> G', 'G -> H'];
    for (let i = 2; i <= lines.length; i++) {
      card.partial({ source: `${lines.slice(0, i).join('\n')}\n` });
      if (card.calls('tools/call').length) card.answer({ structuredContent: { svg: svg(), nodes: i, connectors: i - 1 } });
      await wait(100);
    }
    // A line every 100 ms for 700 ms: frames went out while the model was still writing, not only after it stopped.
    expect(card.calls('tools/call').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps one preview in flight and sends the newest text when it returns', async () => {
    const card = await mount();
    card.partial({ source: 'A -> B\n' });
    await wait(EVERY_MS + 50);
    card.partial({ source: 'A -> B\nB -> C\n' });
    card.partial({ source: 'A -> B\nB -> C\nC -> D\n' });
    await wait(EVERY_MS + 50);
    expect(card.calls('tools/call')).toHaveLength(1);
    card.answer(preview(2, 1, node('a'), node('b'), edge('a-b')));
    await wait(EVERY_MS + 100);
    const calls = card.calls('tools/call');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.params).toMatchObject({ arguments: { source: 'A -> B\nB -> C\nC -> D' } });
  });

  it('draws only when the count grows, keeps shapes already drawn and animates only the new ones', async () => {
    const card = await mount();
    const live = card.$('live');
    card.partial({ source: 'A -> B\n' });
    await wait(EVERY_MS + 50);
    card.answer(preview(2, 1, edge('a-b'), node('a'), node('b')));
    await wait(0);
    expect(live.hidden).toBe(false);
    const a = live.querySelector('[data-node-id="a"]')!;
    expect(a.querySelector(':scope > g.ofk-pop')).not.toBeNull();
    const paths = live.querySelectorAll('[data-connector-id="a-b"] path');
    expect([...paths].every((path) => path.classList.contains('ofk-draw') && path.getAttribute('pathLength') === '1')).toBe(true);
    // Connectors draw after their shapes appear.
    const delay = (el: Element | null) => parseFloat((el as HTMLElement).style.getPropertyValue('--d'));
    expect(delay(paths[0]!)).toBeGreaterThan(delay(live.querySelector('[data-node-id="b"] > g.ofk-pop')));
    expect(card.$('meta').textContent).toBe('Drawing · 2 nodes · 1 connector');

    // Same count (a label still being typed): the picture on screen stays.
    card.partial({ source: 'A -> B\nB\n' });
    await wait(EVERY_MS + 50);
    card.answer(preview(2, 1, edge('a-b'), node('a', 'changed'), node('b')));
    await wait(0);
    expect(live.querySelector('[data-node-id="a"] text')!.textContent).toBe('a');

    // More shapes: patched in place. `a` is the same element, still with its first animation; `c` is new and animates.
    card.partial({ source: 'A -> B\nB -> C\n' });
    await wait(EVERY_MS + 50);
    card.answer(preview(3, 2, edge('a-b'), edge('b-c'), node('a'), node('b'), node('c')));
    await wait(0);
    expect(live.querySelector('[data-node-id="a"]')).toBe(a);
    expect(live.querySelectorAll('[data-node-id="a"] g.ofk-pop')).toHaveLength(1);
    expect(live.querySelector('[data-node-id="c"] > g.ofk-pop')).not.toBeNull();
    expect(live.querySelector('[data-connector-id="b-c"] path.ofk-draw')).not.toBeNull();
    // Order follows the server's picture.
    expect([...live.firstElementChild!.children].map((el) => el.getAttribute('data-node-id') ?? el.getAttribute('data-connector-id') ?? el.localName))
      .toEqual(['rect', 'frame', 'a-b', 'b-c', 'a', 'b', 'c']);
  });

  it('strips scripts, handlers and outside links from a preview', async () => {
    const card = await mount();
    card.partial({ source: 'A -> B\n' });
    await wait(EVERY_MS + 50);
    card.answer(preview(1, 0, '<script>window.pwned = 1</script><g data-node-id="x" onclick="window.pwned = 1"><a href="javascript:alert(1)"><text>x</text></a><image href="https://evil.test/p.png"/><image href="data:image/png;base64,AA"/><a><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/></a></g>'));
    await wait(0);
    const live = card.$('live');
    expect(live.querySelector('script')).toBeNull();
    expect(live.querySelector('[onclick]')).toBeNull();
    // SMIL could set an href after the check: gone.
    expect(live.querySelector('set, animate')).toBeNull();
    expect(live.querySelector('a')!.hasAttribute('href')).toBe(false);
    const images = [...live.querySelectorAll('image')].map((image) => image.getAttribute('href'));
    expect(images).toEqual([null, 'data:image/png;base64,AA']);
    expect((card.window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('gives way to the final result: a late preview is ignored, the picture is the result\'s, the preview goes once it loads', async () => {
    const card = await mount();
    card.partial({ source: 'A -> B\n' });
    await wait(EVERY_MS + 50);
    card.answer(preview(2, 1, node('a'), node('b')));
    card.partial({ source: 'A -> B\nB -> C\n' });
    await wait(EVERY_MS + 50);
    card.result(CARD);
    card.answer(preview(3, 2, node('a'), node('b'), node('c')));
    await wait(0);
    expect(card.$('live').querySelector('[data-node-id="c"]')).toBeNull();
    expect((card.$('img') as HTMLImageElement).src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(card.$('meta').textContent).toBe('2 nodes · 1 connector');
    card.loaded();
    expect(card.$('live').hidden).toBe(true);
    expect(card.$('live').childElementCount).toBe(0);
    card.partial({ source: 'A -> B\nB -> C\nC -> D\n' });
    await wait(EVERY_MS + 50);
    expect(card.calls('tools/call')).toHaveLength(2);
  });

  it('leaves a host that sends no partials, or cannot proxy tool calls, exactly as before', async () => {
    const quiet = await mount();
    quiet.send({ method: 'ui/notifications/tool-input', params: { arguments: { source: 'A -> B' } } });
    quiet.result(CARD);
    await wait(EVERY_MS + 50);
    expect(quiet.calls('tools/call')).toHaveLength(0);
    expect(quiet.$('live').hidden).toBe(true);
    expect(quiet.$('title').textContent).toBe('Checkout');

    const noTools = await mount({});
    noTools.partial({ source: 'A -> B\nB -> C\n' });
    await wait(EVERY_MS + 50);
    expect(noTools.calls('tools/call')).toHaveLength(0);
    expect(noTools.$('drawing').hidden).toBe(true);
  });
});

describe('viewer: Claude sees what it drew', () => {
  it('sends a PNG of at most 512 px after the final picture loads, when the host takes images', async () => {
    const card = await mount({ updateModelContext: { text: {}, image: {} } });
    card.result(CARD);
    card.loaded(1600, 900);
    await wait(1700);
    const [update] = card.calls('ui/update-model-context');
    const content = update!.params!.content as { type: string; data?: string; mimeType?: string; text?: string }[];
    expect(content.find((block) => block.type === 'image')).toEqual({ type: 'image', data: 'UE5H', mimeType: 'image/png' });
    expect(content.find((block) => block.type === 'text')!.text).toMatch(/"Checkout".*2 nodes, 1 connector/);
  }, 5_000);

  it('sends nothing to a host that did not offer context updates, or offered them without images', async () => {
    const none = await mount({});
    const textOnly = await mount({ updateModelContext: { text: {} } });
    for (const card of [none, textOnly]) { card.result(CARD); card.loaded(); }
    await wait(1700);
    expect([...none.calls('ui/update-model-context'), ...textOnly.calls('ui/update-model-context')]).toHaveLength(0);
  }, 5_000);
});

describe('viewer: older cards step back', () => {
  const stamped = (createdAt: number, seq: number) => ({ ...CARD, createdAt, seq });
  const isSuperseded = (card: Awaited<ReturnType<typeof mount>>) => card.window.document.documentElement.classList.contains('superseded');

  it('greys out the older card, whichever mounts first (a reloaded chat mounts lazily)', async () => {
    const older = await mount({}, { toolInfo: { id: 'tool-1' } });
    const newer = await mount({}, { toolInfo: { id: 'tool-2' } });
    newer.result(stamped(2000, 2));
    await wait(20);
    older.result(stamped(1000, 1));
    await wait(20);
    expect(isSuperseded(older)).toBe(true);
    expect(older.$('badge').hidden).toBe(false);
    expect(isSuperseded(newer)).toBe(false);
    expect(newer.$('badge').hidden).toBe(true);
  });

  it('breaks a tie on createdAt by seq, then by instance id', async () => {
    const first = await mount({}, { toolInfo: { id: 'a' } });
    const second = await mount({}, { toolInfo: { id: 'b' } });
    first.result(stamped(5000, 8));
    second.result(stamped(5000, 7));
    await wait(20);
    expect([isSuperseded(first), isSuperseded(second)]).toEqual([false, true]);

    const third = await mount({}, { toolInfo: { id: 'z' } });
    third.result(stamped(9000, 1));
    const fourth = await mount({}, { toolInfo: { id: 'y' } });
    fourth.result(stamped(9000, 1));
    await wait(20);
    expect([isSuperseded(third), isSuperseded(fourth)]).toEqual([false, true]);
  });

  it('keeps an older card from updating the model context', async () => {
    const older = await mount({ updateModelContext: {} }, { toolInfo: { id: 'old' } });
    const newer = await mount({ updateModelContext: {} }, { toolInfo: { id: 'new' } });
    older.result(stamped(1000, 1));
    newer.result(stamped(2000, 2));
    await wait(20);
    older.loaded(); newer.loaded();
    await wait(1700);
    expect(older.calls('ui/update-model-context')).toHaveLength(0);
    expect(newer.calls('ui/update-model-context')).toHaveLength(1);
  }, 5_000);
});
