// Request guards of the live bridge: who may knock on the port at all.
import type { IncomingMessage } from 'node:http';

/**
 * This machine by name: a rebound DNS name (evil.example → 127.0.0.1) is refused. Any port, so an
 * SSH or devcontainer forward (Host: localhost:9000) still pairs.
 */
export const isAllowedBridgeHost = (host: string | undefined): boolean =>
  /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host?.toLowerCase() ?? '');

/**
 * `/call` is for MCP servers on this machine. A browser always sends Origin or Sec-Fetch-* with a POST,
 * and cannot send JSON to another origin without a preflight, so any of those marks a web page.
 */
export const isFromBrowser = (request: IncomingMessage): boolean => {
  const { headers } = request;
  return headers.origin !== undefined || headers['sec-fetch-site'] !== undefined || headers['sec-fetch-mode'] !== undefined
    || !/^application\/json\b/i.test(headers['content-type'] ?? '');
};
