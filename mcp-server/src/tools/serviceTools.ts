// The service half of the tool surface: which diagram a call lands on, and the tools that hold or release one.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolError } from '../lib/errors.js';
import type { ServiceBinding, ServiceClient } from '../lib/serviceClient.js';

/** Appended to a service-mode drawing result when this session cannot receive the canvas's comments (AC-5). */
export const NO_CHANNEL_NOTE = 'This session cannot receive comments from the canvas. Restart it with channels enabled.';

export const diagramField = z.string().min(1).optional()
  .describe('Service mode: id of the connected diagram to act on. Needed only when this session is connected to more than one.');

const describe = (bindings: readonly ServiceBinding[]): string => bindings.map(({ project, id, title }) => `${project}/${id} ("${title}")`).join(', ');

/** The connected diagram a call targets (AC-7). A session with none does nothing (D5). */
export function pickBinding(bindings: readonly ServiceBinding[], diagram?: string, project?: string): ServiceBinding {
  const matching = bindings.filter((binding) => (!diagram || binding.id === diagram) && (!project || binding.project === project));
  if (matching.length === 1) return matching[0]!;
  if (matching.length > 1) throw new Error(`This session is connected to ${matching.length} diagrams: ${describe(matching)}. Pass "diagram" with the id of the one to use.`);
  if (bindings.length) throw new Error(`This session is not connected to ${diagram ?? project}. Its diagrams: ${describe(bindings)}. Use connect_diagram first to add another.`);
  throw new Error('This session is not connected to a diagram. Ask the user which one, then call connect_diagram, or create_diagram with a project to make a new one.');
}

/** The project a new diagram goes in: the one named, else the only one there is. */
export async function pickProject(service: ServiceClient, project?: string): Promise<string> {
  const names = (await service.projects()).map(({ name }) => name);
  if (project) {
    if (!names.includes(project)) throw new Error(`There is no project "${project}". Projects: ${names.join(', ') || 'none configured'}.`);
    return project;
  }
  if (names.length === 1) return names[0]!;
  if (!names.length) throw new Error('The service has no projects. Add one to its config file (~/.config/openflowkit/service.json).');
  throw new Error(`Pass "project": the service has ${names.length} (${names.join(', ')}).`);
}

function text(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function registerServiceTools(server: McpServer, service: ServiceClient): void {
  server.registerTool('connect_diagram', {
    title: 'Connect to a diagram',
    description: 'Connect this session to an existing diagram in a service project, so drawing tools act on it and its canvas comments reach you. '
      + 'Only when the user asks for something about that diagram. A diagram another session holds is refused: the user disconnects it first.',
    inputSchema: {
      project: z.string().min(1).describe('Service project name (see list_diagrams).'),
      diagram: z.string().min(1).describe('Diagram id (see list_diagrams).'),
    },
  }, async ({ project, diagram }): Promise<CallToolResult> => {
    try {
      await service.ensure();
      return text({ connected: await service.bind(project, diagram) });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerTool('disconnect_diagram', {
    title: 'Disconnect from a diagram',
    description: 'Release a diagram this session holds, so another session or the user can take it. Without arguments, releases the only one this session holds.',
    inputSchema: {
      project: z.string().min(1).optional(),
      diagram: z.string().min(1).optional(),
    },
  }, async ({ project, diagram }): Promise<CallToolResult> => {
    try {
      const binding = pickBinding(await service.bindings(), diagram, project);
      await service.unbind(binding.project, binding.id);
      return text({ disconnected: binding });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });
}
