// Test helper: a fake MCP server that captures tool registrations so tests can
// inspect descriptions/schemas and call handlers directly (no network, no stdio).

export interface CapturedTool {
  name: string;
  desc: string;
  schema: Record<string, any>;
  handler: (args: any) => Promise<any>;
}

export class ToolCapture {
  readonly tools: CapturedTool[] = [];

  // Matches McpServer.tool(name, description, schema, handler).
  tool = (name: string, desc: string, schema: Record<string, any>, handler: (args: any) => Promise<any>): void => {
    this.tools.push({ name, desc, schema, handler });
  };

  get(name: string): CapturedTool {
    const t = this.tools.find((x) => x.name === name);
    if (!t) throw new Error(`Tool not registered: ${name}`);
    return t;
  }
}
