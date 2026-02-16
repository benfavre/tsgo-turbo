# tsgo-turbo

## Project Structure
- `packages/shared` — Shared types, protocol definitions, constants (build first)
- `packages/server` — Custom LSP server integrating tsgo + oxc
- `packages/extension` — VS Code extension client with inspector panel

## Architecture Decisions
- **bun workspaces + turborepo** for monorepo management
- **esbuild** for fast bundling (not webpack)
- **Node16 module resolution** for ESM/CJS interop
- **Structured JSON logging** with performance tracing built in
- **Type expansion guards** to prevent infinite recursion in Prisma/tRPC types
- **File-level caching** with content-hash invalidation
- **Process isolation** — tsgo and oxc run as separate child processes with IPC

## Key Commands
- `bun run build` — Build all packages
- `bun run dev` — Watch mode development
- `bun run test` — Run all tests
- `bun run package` — Build .vsix extension package

## Conventions
- All source in TypeScript strict mode
- Errors are structured objects, never thrown strings
- Every public function has JSDoc
- Performance-critical paths have `perf.mark()` instrumentation
