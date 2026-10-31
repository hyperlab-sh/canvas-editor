// What bare `openflowkit` prints at a terminal: the name in block letters, then three
// commands to try. Scripts and pipes never see it (cli.ts keeps the usage error there).

const GLYPHS: Record<string, readonly string[]> = {
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#### ', '#    ', '#    '],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  F: ['#####', '#    ', '#### ', '#    ', '#    '],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  W: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  K: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  I: ['###', ' # ', ' # ', ' # ', '###'],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
};

const ORANGE = '38;2;249;115;22';
const DIM = '2';
const BOLD = '1';

/** "FLOWKIT" is the widest word: 78 columns. */
const BIG_LETTERS_MIN_COLUMNS = 80;

/** Two columns per pixel: terminal cells are about twice as tall as wide. */
function blockWord(word: string, paint: (code: string, text: string) => string): string[] {
  return GLYPHS.O!.map((_, row) => [...word].map((letter) => GLYPHS[letter]![row]).join(' ')
    .replace(/\s+$/, '').replace(/ /g, '  ').replace(/#+/g, (run) => paint(ORANGE, '██'.repeat(run.length))));
}

export function welcome(options: { readonly columns: number; readonly color: boolean; readonly version: string }): string {
  const paint = (code: string, text: string) => (options.color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const title = `✻ Welcome to ${paint(BOLD, 'OpenFlowKit')} ${options.version}`;
  const titleWidth = `✻ Welcome to OpenFlowKit ${options.version}`.length;
  const box = [
    paint(ORANGE, `╭${'─'.repeat(titleWidth + 2)}╮`),
    `${paint(ORANGE, '│')} ${title} ${paint(ORANGE, '│')}`,
    paint(ORANGE, `╰${'─'.repeat(titleWidth + 2)}╯`),
  ];
  const tries: readonly [string, string][] = [
    ['openflowkit render flow.mmd -o flow.svg', 'Mermaid, D2 or Structurizr → SVG'],
    ['openflowkit validate flow.ofk', 'errors per line; exit 1 for CI'],
    ['openflowkit map . --html map.html', 'what this repo is made of, as a page'],
  ];
  const wide = options.columns >= 80;
  const tryLines = tries.flatMap(([command, what]) => (wide
    ? [`  ${paint(BOLD, command.padEnd(41))}${paint(DIM, what)}`]
    : [`  ${paint(BOLD, command)}`, `    ${paint(DIM, what)}`]));
  return [
    ...box,
    '',
    ...(options.columns >= BIG_LETTERS_MIN_COLUMNS ? [...blockWord('OPEN', paint), '', ...blockWord('FLOWKIT', paint), ''] : []),
    paint(DIM, 'Diagrams agents write, kept valid, editable and next to the code.'),
    '',
    paint(BOLD, 'Try'),
    ...tryLines,
    '',
    `${paint(BOLD, 'Agents')}  ${paint(DIM, 'claude mcp add openflowkit -- npx -y openflowkit mcp')}`,
    `${paint(BOLD, 'Docs')}    ${paint(DIM, 'https://docs.openflowkit.com/cli/')}`,
    '',
    paint(DIM, 'openflowkit --help lists every command.'),
  ].join('\n');
}
