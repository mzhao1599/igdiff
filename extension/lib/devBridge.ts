/**
 * Dev-only bridge between the instagram.com page and the extension.
 *
 * Lets a script running in the page (DevTools console, or an automation tool
 * driving a signed-in browser) ask the extension for status, run the probe,
 * sync and wait, read a summary, or reload the extension from disk. Only
 * installed when DIAGNOSTICS_ENABLED, so production builds don't contain it.
 * Commands are read-only towards Instagram.
 *
 * From the page:
 *
 *   await new Promise(resolve => {
 *     const id = crypto.randomUUID();
 *     addEventListener('message', function on(e) {
 *       if (e.data?.source === 'follower-tracker-dev' && e.data.direction === 'reply' && e.data.id === id) {
 *         removeEventListener('message', on);
 *         resolve(e.data);
 *       }
 *     });
 *     postMessage({ source: 'follower-tracker-dev', direction: 'request', id, command: 'env' }, location.origin);
 *   });
 */
export const DEV_BRIDGE_SOURCE = 'follower-tracker-dev';

export type DevBridgeHandlers = Record<string, (args: unknown) => Promise<unknown>>;

interface BridgeRequest {
  readonly source: typeof DEV_BRIDGE_SOURCE;
  readonly direction: 'request';
  readonly id: string;
  readonly command: string;
  readonly args?: unknown;
}

function isBridgeRequest(data: unknown): data is BridgeRequest {
  const record = data as Partial<BridgeRequest> | null;
  return (
    !!record &&
    record.source === DEV_BRIDGE_SOURCE &&
    record.direction === 'request' &&
    typeof record.id === 'string' &&
    typeof record.command === 'string'
  );
}

export function installDevBridge(handlers: DevBridgeHandlers): () => void {
  const listener = (event: MessageEvent) => {
    if (event.source !== window || !isBridgeRequest(event.data)) {
      return;
    }
    const { id, command, args } = event.data;
    const reply = (payload: { result?: unknown; error?: string }) =>
      window.postMessage({ source: DEV_BRIDGE_SOURCE, direction: 'reply', id, command, ...payload }, window.location.origin);
    const handler = handlers[command];
    if (!handler) {
      reply({ error: `Unknown command "${command}". Known: ${Object.keys(handlers).join(', ')}` });
      return;
    }
    handler(args).then(
      result => reply({ result }),
      error => reply({ error: error instanceof Error ? error.message : String(error) }),
    );
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
