#!/usr/bin/env node
/**
 * typegraph-mcp — entry point.
 *
 *   (no arguments)  serve MCP over stdio, when a client is on the other end
 *   setup           install the MCP server config + skills for the selected agents
 *   remove          undo it
 *   check           health check (see check.ts)
 *
 * No-arguments is the MCP server so that an agent config never has to name a
 * subcommand or a path inside this package — `npx typegraph-mcp` is enough. But
 * a person typing that in a terminal means the installer, not a process that
 * sits silently reading stdin, so a TTY on stdin prints usage instead. An MCP
 * client always arrives with stdio piped, which is what makes the two cases
 * distinguishable without a flag.
 *
 * Every branch loads its implementation dynamically. That is not tidiness:
 * @clack/prompts writes to stdout, and stdout carries nothing but JSON-RPC once
 * a client is connected, so the installer must not be reachable from the
 * server's module graph at all.
 */
import path from "node:path";

const USAGE = `typegraph-mcp — type-aware TypeScript navigation for AI agents

  typegraph-mcp setup [--yes] [--project-root PATH] [--tsconfig PATH]
                               install MCP config + skills for detected agents
  typegraph-mcp remove [--project-root PATH]
                               undo it
  typegraph-mcp check [--project-root PATH] [--tsconfig PATH]
                               verify binary, versions, and installed paths

  typegraph-mcp                 with stdio piped, serves MCP
`;

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === undefined) {
    // A TTY means a human, and a human did not mean "start a stdio server".
    if (process.stdin.isTTY) {
      console.log(USAGE);
      return;
    }
    await import("./server.ts");
    return;
  }

  const yes = args.includes("--yes") || args.includes("-y");
  const projectRootOption = optionValue(args, "--project-root");
  const tsconfigOption = optionValue(args, "--tsconfig");
  const configuredProjectRoot = projectRootOption ?? process.env["TYPEGRAPH_PROJECT_ROOT"];
  const projectRoot = configuredProjectRoot ? path.resolve(configuredProjectRoot) : process.cwd();
  if (projectRootOption) process.env["TYPEGRAPH_PROJECT_ROOT"] = projectRoot;
  if (tsconfigOption) process.env["TYPEGRAPH_TSCONFIG"] = tsconfigOption;
  const sourceDir = path.resolve(import.meta.dirname, "..");

  switch (command) {
    case "serve":
      await import("./server.ts");
      break;
    case "setup": {
      const { setup } = await import("./install.ts");
      await setup(projectRoot, sourceDir, yes);
      break;
    }
    case "remove": {
      const { remove } = await import("./install.ts");
      await remove(projectRoot);
      break;
    }
    case "check":
      await import("./check.ts");
      break;
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
