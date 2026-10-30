# canvas

The [Canvas](https://canvas.hyperlab.sh) command line. Turn diagram text into SVG, check diagrams in CI, and map a repository.

```sh
npx @hyperlab.sh/canvas render flow.mmd -o flow.svg        # Mermaid, D2, Structurizr or OpenFlow DSL → SVG
npx @hyperlab.sh/canvas convert flow.mmd -o flow.openflow.json   # → a file you can open and edit in the app
npx @hyperlab.sh/canvas validate flow.canvas                  # line-by-line errors; exit 1 on a broken diagram
npx @hyperlab.sh/canvas discover .                         # propose an architecture model from the repo
npx @hyperlab.sh/canvas map . --html map.html              # what the repo is made of, as a page
npx @hyperlab.sh/canvas --help                             # every command
npx -y @hyperlab.sh/canvas mcp                             # the MCP server for Claude Code, Cursor and other agents
```

Install it once with `npm i -g canvas`, then run `canvas …`.

For Claude Code: `claude mcp add -s user canvas -- npx -y @hyperlab.sh/canvas mcp`, then open [canvas.hyperlab.sh/#/connect](https://canvas.hyperlab.sh/#/connect) so it draws on your canvas. Other agents, and the hosted connector for claude.ai and ChatGPT: [Connect your agent](https://docs.canvas.hyperlab.sh/connect-your-agent/). The engine is [`@hyperlab.sh/canvas-mcp`](https://www.npmjs.com/package/@hyperlab.sh/canvas-mcp); both names run the same thing. Docs: [docs.canvas.hyperlab.sh/cli](https://docs.canvas.hyperlab.sh/cli/).

MIT licensed.
