#!/usr/bin/env node
// MCP server for LM Studio's chat (Program -> Install -> Edit mcp.json).
// stdout carries JSON-RPC only; diagnostics go to stderr.
import path from 'node:path';
import os from 'node:os';
import { resolveArchifyRoot } from '../lib/archify-cli.mjs';
import { startMcpServer } from '../lib/mcp-server.mjs';

try {
  startMcpServer({
    archifyRoot: resolveArchifyRoot(),
    outDir: path.resolve(process.env.ARCHIFY_OUT_DIR ?? path.join(os.homedir(), 'archify-out')),
    open: process.env.ARCHIFY_OPEN === '1',
  });
} catch (error) {
  process.stderr.write(`archify-mcp: ${error.message}\n`);
  process.exit(1);
}
