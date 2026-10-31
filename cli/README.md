# openflowkit

The [OpenFlowKit](https://openflowkit.com) command line. Turn diagram text into SVG, check diagrams in CI, and map a repository.

```sh
npx openflowkit render flow.mmd -o flow.svg        # Mermaid, D2, Structurizr or OpenFlow DSL → SVG
npx openflowkit convert flow.mmd -o flow.openflow.json   # → a file you can open and edit in the app
npx openflowkit validate flow.ofk                  # line-by-line errors; exit 1 on a broken diagram
npx openflowkit discover .                         # propose an architecture model from the repo
npx openflowkit map . --html map.html              # what the repo is made of, as a page
npx openflowkit --help                             # every command
npx -y openflowkit mcp                             # the MCP server for Claude Code, Cursor and other agents
```

Install it once with `npm i -g openflowkit`, then run `openflowkit …`.

For Claude Code: `claude mcp add -s user openflowkit -- npx -y openflowkit mcp`, then open [app.openflowkit.com/#/connect](https://app.openflowkit.com/#/connect) so it draws on your canvas. Other agents, and the hosted connector for claude.ai and ChatGPT: [Connect your agent](https://docs.openflowkit.com/connect-your-agent/). The engine is [`@openflowkit/openflowkit-mcp`](https://www.npmjs.com/package/@openflowkit/openflowkit-mcp); both names run the same thing. Docs: [docs.openflowkit.com/cli](https://docs.openflowkit.com/cli/).

MIT licensed.
