import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const DEFAULT_PORT = 43120;
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export interface ProjectConfig {
  readonly name: string;
  readonly path: string;
}

export interface ServiceConfig {
  readonly port: number;
  readonly projects: readonly ProjectConfig[];
}

function configPath(): string {
  return process.env.OPENFLOWKIT_SERVICE_CONFIG || join(homedir(), '.config', 'openflowkit', 'service.json');
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** Writes the default config only when the file is absent; an existing file is never touched. */
async function writeDefault(file: string): Promise<void> {
  const scratch = join(homedir(), '.local', 'share', 'openflowkit', 'diagrams');
  await mkdir(scratch, { recursive: true });
  await mkdir(dirname(file), { recursive: true });
  const body = JSON.stringify({ port: DEFAULT_PORT, projects: [{ name: 'scratch', path: scratch }] }, null, 2) + '\n';
  const handle = await open(file, 'wx').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return null;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.write(body);
  } finally {
    await handle.close();
  }
}

export async function loadConfig(): Promise<ServiceConfig> {
  const file = configPath();
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeDefault(file);
    text = await readFile(file, 'utf8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Service config ${file} is not valid JSON.`);
  }
  const { port, projects } = (raw ?? {}) as { port?: unknown; projects?: unknown };
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Service config ${file}: "port" must be an integer from 1 to 65535.`);
  }
  if (!Array.isArray(projects)) throw new Error(`Service config ${file}: "projects" must be a list of { name, path }.`);
  const seen = new Set<string>();
  const paths = new Map<string, string>();
  const parsed: ProjectConfig[] = [];
  for (const entry of projects as { name?: unknown; path?: unknown }[]) {
    const name = entry?.name;
    if (typeof name !== 'string' || !PROJECT_NAME.test(name)) {
      throw new Error(`Service config ${file}: invalid project name ${JSON.stringify(name)}; use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`);
    }
    if (seen.has(name)) throw new Error(`Service config ${file}: project name "${name}" is listed twice.`);
    seen.add(name);
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path)) {
      throw new Error(`Service config ${file}: project "${name}" needs an absolute "path".`);
    }
    const path = resolve(entry.path);
    if (!(await isDirectory(path))) throw new Error(`Service config ${file}: project "${name}" path ${path} is not a directory.`);
    const other = paths.get(path);
    if (other) throw new Error(`Service config ${file}: project "${name}" path ${path} is already used by project "${other}".`);
    paths.set(path, name);
    parsed.push({ name, path });
  }
  return { port, projects: parsed };
}
