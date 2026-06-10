/**
 * Extension point registry for claude-recall-pro.
 * Core calls getExtraTools() / getHookExtensions() — pro registers into them at build time.
 * No-op when pro is not bundled.
 */

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

export type HookExtension = {
  event: string;
  handler: (data: Record<string, unknown>) => Promise<string | void>;
};

export type RouteHandler = {
  path: string;
  method: 'GET' | 'POST';
  handler: (req: Request) => Promise<Response>;
};

const extraTools: McpToolDef[] = [];
const hookExtensions: HookExtension[] = [];
const extraRoutes: RouteHandler[] = [];

export function registerMcpTool(tool: McpToolDef): void {
  extraTools.push(tool);
}

export function registerHookExtension(ext: HookExtension): void {
  hookExtensions.push(ext);
}

export function registerRoute(route: RouteHandler): void {
  extraRoutes.push(route);
}

export function getExtraTools(): McpToolDef[] {
  return extraTools;
}

export function getHookExtensions(event: string): HookExtension[] {
  return hookExtensions.filter(h => h.event === event);
}

export function getExtraRoutes(): RouteHandler[] {
  return extraRoutes;
}
