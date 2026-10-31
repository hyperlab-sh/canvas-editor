// Real-DSL validation: the same parse-then-compile check `openflowkit validate`
// runs, so an agent sees every line the compiler drops. Mermaid converts first;
// the report carries the DSL it became and what did not carry over.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkForValidation, failed } from '../cliCommands.js';
import { toolError } from '../lib/errors.js';

export function registerValidateDsl(server: McpServer): void {
  server.registerTool(
    'validate_openflow_dsl',
    {
      title: 'Validate OpenFlow DSL',
      description:
        'Parse and compile OpenFlow DSL — or Mermaid, Structurizr DSL or D2, converted first — and return structured diagnostics ' +
        '(code, severity, line, column, message, hint), the same check as `openflowkit validate`. `ok` is false on any error: ' +
        'text that cannot be drawn, or a line the parser could not read (create_diagram would draw without it). Warnings name ' +
        'guesses (an unknown word, a misspelled header) that still draw. For another language, `converted.dsl` is what it became and ' +
        '`converted.losses` name the lines of your text that did not carry over; diagnostics then refer to `converted.dsl`.',
      inputSchema: { dsl: z.string().describe('OpenFlow DSL, Mermaid, Structurizr DSL or D2 source to validate.') },
    },
    async ({ dsl }) => {
      try {
        const checked = await checkForValidation(dsl);
        const { lint, issues } = checked;
        const ok = !failed(checked, false);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok,
              family: lint.family,
              reservedFamily: lint.reserved,
              statements: lint.statements,
              lines: lint.lines,
              diagnostics: issues,
              ...(lint.converted ? { converted: lint.converted } : {}),
              hint: !ok
                ? 'Fix the errors, then re-validate. See get_syntax for the grammar section that applies.'
                : issues.length > 0
                  ? 'Draws, with warnings: each names a guess the parser made. Fix them unless that is what you meant.'
                  : 'Valid. Next: create_diagram(dsl) in the paired editor, or openflow_create + create_diagram for file mode.',
            }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
