# tsgo Turbo

**High-performance TypeScript/JavaScript analysis for VS Code** -- powered by [tsgo](https://github.com/nicolo-ribaudo/tc39-proposal-type-annotations) and [oxc](https://oxc-project.github.io/).

---

## The Problem

Standard TypeScript language server (`tsserver`) struggles with large codebases that rely on deeply generic or recursive type constructs. The most painful offenders include:

- **Prisma** -- Deeply nested model types with dozens of relations, `include` chains, and conditional select fields that create exponential type expansion.
- **tRPC** -- Recursive router type inference across hundreds of procedures, where the merged router type can exceed millions of type nodes.
- **Next.js** -- Complex page/layout type props with middleware chains, `GetServerSideProps` generics, and App Router metadata types that cascade through the module graph.

### Symptoms

If you've hit any of these, you know the pain:

- Infinite type expansion causing the language server to hang for 30+ seconds
- Multi-second hover delays that make exploratory coding impossible
- IDE freezing or becoming completely unresponsive during type resolution
- Memory usage ballooning to 8-10 GB+ for a single TypeScript server process
- "Type instantiation is excessively deep and possibly infinite" errors flooding your diagnostics
- ESLint taking 30+ seconds to lint a single file with complex type-aware rules

## The Solution

tsgo Turbo replaces the performance-critical parts of `tsserver` with purpose-built, high-performance tools:

- **tsgo** -- Microsoft's Go-based TypeScript type checker. Runs type checking 10-100x faster than the standard TypeScript compiler by leveraging Go's concurrency model and optimized memory layout.
- **oxc** -- Rust-based linter from the oxc-project. Provides 50-100x faster linting than ESLint through zero-copy parsing and a single-pass analysis architecture.
- **Type expansion guards** -- Configurable depth limits prevent infinite type recursion. When a type like `Prisma.UserGetPayload<{ include: { posts: { include: { author: true } } } }>` starts expanding past a safe threshold, the guard truncates and reports a clear warning instead of hanging.
- **Smart caching** -- Content-hash invalidated LRU cache ensures that unchanged files are never re-analyzed. Cache entries are keyed by file content hash, not timestamp, so saving a file without changing it is free.
- **Process isolation** -- tsgo and oxc run in managed child processes with configurable memory limits. A runaway type expansion in one file cannot starve the rest of your IDE.
- **Inspector panel** -- A built-in webview panel provides real-time visibility into analysis performance, cache hit rates, active processes, and type expansion warnings.

## Features

### Type Checking (tsgo)

- Full TypeScript type checking using Microsoft's Go-based compiler
- Configurable maximum type expansion depth (default: 50 levels)
- Per-file timeout protection (default: 30 seconds)
- Per-process memory limits (default: 4 GB)
- Process pool with up to 4 concurrent tsgo instances
- Structured error output with precise source locations

### Linting (oxc)

- High-speed linting powered by the Rust-based oxc linter
- Per-file timeout protection (default: 10 seconds)
- Process pool with up to 8 concurrent oxc instances
- Support for custom oxc configuration files
- Per-rule enable/disable/severity overrides

### Caching

- Content-hash based cache invalidation -- no stale results
- LRU eviction with configurable max entries (default: 10,000) and size limit (default: 512 MB)
- Configurable TTL (default: 5 minutes)
- Cache statistics exposed via the inspector panel
- Manual cache clearing via command palette

### Performance Tracing

- Hierarchical span-based tracing for every analysis operation
- Slow span detection with configurable threshold (default: 1 second)
- Full trace trees viewable in the inspector panel
- Ring buffer retains the most recent 1,000 trace roots

### Structured Logging

- JSON-structured log entries with timestamp, level, source, and context
- Configurable log levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`
- Batched log flushing (default: every 100ms) for minimal performance impact
- Optional pretty-print mode for development
- In-memory ring buffer (2,000 entries) queryable by the inspector

### Inspector Panel

- Real-time webview showing server internals
- Performance traces with hierarchical span visualization
- Cache hit/miss rates and eviction counts
- Active process monitoring (PID, memory, CPU, current file)
- Server status (starting, ready, busy, error, degraded)
- Type expansion warnings with suggested mitigations
- Log viewer with level filtering

### File Watching

- Glob-based include/exclude patterns
- Debounced change detection (default: 150ms)
- Watches `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts` by default
- Automatically excludes `node_modules`, `dist`, `.next`, `coverage`, `.turbo`

## Architecture

```
VS Code Extension (Client)
    |
    | LSP Protocol + Custom Methods
    v
Custom LSP Server
    |
    +-- tsgo Integration (type checking)
    |     \-- Process Pool (max 4 concurrent)
    |
    +-- oxc Integration (linting)
    |     \-- Process Pool (max 8 concurrent)
    |
    +-- Type Expansion Guard
    |     \-- Configurable depth limit (default 50)
    |
    +-- File Cache (LRU, content-hash)
    |     \-- 10,000 entries / 512 MB max
    |
    +-- Type Cache (dependency-aware)
    |
    +-- Structured Logger
    |     \-- Ring buffer + batched flush
    |
    \-- Performance Tracer
          \-- Hierarchical spans + slow detection
```

### Monorepo Structure

```
tsgo-turbo/
  packages/
    shared/        Shared types, protocol definitions, constants
    server/        Custom LSP server integrating tsgo + oxc
    extension/     VS Code extension client with inspector panel
```

- **`@tsgo-turbo/shared`** -- Built first. Contains the `TsgoTurboConfig` interface, all LSP custom method definitions (`tsgoTurbo/perfTrace`, `tsgoTurbo/cacheStats`, etc.), diagnostic types, and default configuration constants.
- **`@tsgo-turbo/server`** -- The LSP server. Depends on `@tsgo-turbo/shared`. Bundles with esbuild targeting Node 22. Contains the structured logger, performance tracer, cache layer, process managers for tsgo and oxc, and type expansion guards.
- **`packages/extension`** -- The VS Code extension client. Activates the LSP server, registers commands, renders the inspector webview panel, and forwards configuration changes to the server.

### Custom LSP Methods

Beyond standard LSP diagnostics, hover, and completion, tsgo Turbo defines these custom notification/request methods:

| Method | Direction | Purpose |
|--------|-----------|---------|
| `tsgoTurbo/perfTrace` | Server -> Client | Performance trace completed |
| `tsgoTurbo/typeExpansionWarning` | Server -> Client | Type depth limit exceeded |
| `tsgoTurbo/cacheStats` | Server -> Client | Cache statistics update |
| `tsgoTurbo/serverStatus` | Server -> Client | Server readiness/health |
| `tsgoTurbo/logEntry` | Server -> Client | Structured log entry |
| `tsgoTurbo/inspectorData` | Client -> Server | Request inspector panel data |
| `tsgoTurbo/clearCache` | Client -> Server | Clear all caches |
| `tsgoTurbo/reloadConfig` | Client -> Server | Reload configuration |
| `tsgoTurbo/analyzeFile` | Client -> Server | Analyze single file on demand |

## Quick Start

### Prerequisites

- **Node.js** >= 22.0.0
- **Bun** >= 1.2.0
- **VS Code** >= 1.96.0

### Installation from Source

```bash
# Clone the repository
git clone https://github.com/your-org/tsgo-turbo.git
cd tsgo-turbo

# Install dependencies
bun install

# Build all packages
bun run build

# Package the extension
bun run package
```

This produces a `.vsix` file in `packages/extension/` that you can install in VS Code:

```
code --install-extension packages/extension/tsgo-turbo-0.1.0.vsix
```

### Installation from Marketplace

> Coming soon.

## Configuration

All settings are under the `tsgoTurbo` namespace in VS Code settings. Below are all available options with their defaults.

### tsgo (Type Checking)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tsgoTurbo.tsgo.enabled` | `boolean` | `true` | Enable tsgo type checking |
| `tsgoTurbo.tsgo.binaryPath` | `string` | auto-detected | Path to tsgo binary |
| `tsgoTurbo.tsgo.maxTypeDepth` | `number` | `50` | Maximum type expansion depth before truncation |
| `tsgoTurbo.tsgo.fileTimeoutMs` | `number` | `30000` | Timeout per file in milliseconds |
| `tsgoTurbo.tsgo.maxMemoryMb` | `number` | `4096` | Max memory per tsgo process in MB |
| `tsgoTurbo.tsgo.flags` | `string[]` | `[]` | Additional command-line flags passed to tsgo |

### oxc (Linting)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tsgoTurbo.oxc.enabled` | `boolean` | `true` | Enable oxc linting |
| `tsgoTurbo.oxc.binaryPath` | `string` | auto-detected | Path to oxc binary |
| `tsgoTurbo.oxc.configPath` | `string` | `undefined` | Path to oxc configuration file |
| `tsgoTurbo.oxc.fileTimeoutMs` | `number` | `10000` | Timeout per file in milliseconds |
| `tsgoTurbo.oxc.rules` | `object` | `undefined` | Per-rule severity overrides (`"off"`, `"warn"`, `"error"`) |

### Logging

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tsgoTurbo.logging.level` | `string` | `"info"` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `tsgoTurbo.logging.file` | `string` | `undefined` | Path to log output file |
| `tsgoTurbo.logging.perfTracing` | `boolean` | `false` | Enable performance tracing |
| `tsgoTurbo.logging.maxFileSizeMb` | `number` | `50` | Max log file size in MB before rotation |
| `tsgoTurbo.logging.prettyPrint` | `boolean` | `true` | Pretty-print logs in the output channel |

### Cache

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tsgoTurbo.cache.enabled` | `boolean` | `true` | Enable result caching |
| `tsgoTurbo.cache.maxEntries` | `number` | `10000` | Maximum number of cache entries |
| `tsgoTurbo.cache.maxSizeMb` | `number` | `512` | Maximum cache size in MB |
| `tsgoTurbo.cache.ttlSeconds` | `number` | `300` | Time-to-live for cache entries in seconds |

### File Watching

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tsgoTurbo.watch.include` | `string[]` | `["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mts", "**/*.cts"]` | Glob patterns to include |
| `tsgoTurbo.watch.exclude` | `string[]` | `["**/node_modules/**", "**/dist/**", "**/.next/**", "**/coverage/**", "**/.turbo/**"]` | Glob patterns to exclude |
| `tsgoTurbo.watch.debounceMs` | `number` | `150` | Debounce delay for file change events in milliseconds |

### Inspector

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tsgoTurbo.inspector.enabled` | `boolean` | `true` | Enable the inspector panel |
| `tsgoTurbo.inspector.autoOpen` | `boolean` | `false` | Automatically open inspector on errors |
| `tsgoTurbo.inspector.maxTraceHistory` | `number` | `1000` | Maximum number of trace roots to retain |

## Inspector Panel

The inspector panel is a built-in webview that provides real-time visibility into the tsgo Turbo server. Open it via the command palette:

```
tsgo Turbo: Open Inspector
```

### Sections

**Server Status** -- Shows whether the server is starting, ready, busy, in an error state, or running in degraded mode. Displays the count of active and queued operations.

**Performance Traces** -- Hierarchical visualization of analysis spans. Each span shows its name, duration, and nested children. Spans exceeding the slow threshold are highlighted. Useful for identifying which files or type constructs are causing latency.

**Cache Statistics** -- Displays total cache entries, total size, hit rate, miss rate, and eviction count. A high hit rate indicates the cache is working effectively. A high eviction count may suggest increasing `maxEntries` or `maxSizeMb`.

**Active Processes** -- Lists all running tsgo and oxc child processes with their PID, memory usage (MB), CPU percentage, the file they are currently analyzing, and how long they have been running.

**Type Expansion Warnings** -- Shows files where type expansion depth exceeded the configured limit. Each warning includes the type name, expansion depth, the full expansion path, and a suggested mitigation (e.g., adding an explicit type annotation to break the inference chain).

**Log Viewer** -- Filterable log stream from the structured logger. Filter by level (trace through fatal) to focus on relevant entries. Shows timestamp, source module, message, and any attached context metadata.

## Performance

Estimated benchmarks comparing standard `tsserver` + ESLint against tsgo Turbo on a large Next.js + tRPC + Prisma monorepo (~1,000 TypeScript files, ~200 Prisma models, ~300 tRPC procedures):

| Metric | tsserver + ESLint | tsgo Turbo | Improvement |
|--------|-------------------|------------|-------------|
| Type check (1,000 files) | ~45s | ~3s | 15x faster |
| Lint (1,000 files) | ~30s | ~0.8s | 37x faster |
| Memory usage (large project) | 8 GB+ | ~1.5 GB | 5x less |
| Hover response (complex type) | 2-15s | 50-200ms | 30-75x faster |
| Initial load to ready | ~60s | ~5s | 12x faster |
| Cache hit analysis | N/A (no cache) | <5ms | -- |

> **Note:** These are estimated figures based on published benchmarks for tsgo and oxc individually. Actual performance depends on project structure, type complexity, and hardware. The type expansion guard and caching layers provide additional gains not reflected in raw tool benchmarks.

## Development

### Prerequisites

```bash
node --version   # >= 22.0.0
bun --version    # >= 1.2.0
```

### Setup

```bash
# Install all dependencies
bun install

# Build all packages (shared -> server -> extension)
bun run build

# Start watch mode for all packages
bun run dev

# Run all tests
bun run test

# Run linting
bun run lint

# Type check without emitting
bun run typecheck

# Clean all build artifacts
bun run clean
```

### Package Build Order

Turborepo manages the dependency graph automatically. The build order is:

1. `@tsgo-turbo/shared` -- types, protocol, constants (no dependencies)
2. `@tsgo-turbo/server` -- LSP server (depends on shared)
3. `packages/extension` -- VS Code extension (depends on shared and server)

### Running the Extension Locally

1. Open the repository in VS Code.
2. Press `F5` or select **Run Extension** from the launch configurations.
3. A new VS Code Extension Development Host window opens with the extension loaded.
4. Open a TypeScript project in the development host to test.

To debug the LSP server simultaneously:

1. Select the **Run Extension + Server Debug** compound configuration.
2. Set breakpoints in `packages/server/src/`.
3. The server attaches on port 6009 with automatic reconnection.

### Running Tests

```bash
# Run all tests once
bun run test

# Run tests in watch mode (via vitest)
bun run --filter '*' exec vitest
```

### Project Conventions

- All source code uses TypeScript strict mode.
- Errors are structured objects, never thrown strings.
- Every public function has JSDoc documentation.
- Performance-critical paths have `perf.mark()` instrumentation.
- Module imports use `.js` extensions (Node16 module resolution).
- esbuild is used for bundling (not webpack) for fast builds.

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Build orchestration | [Turborepo](https://turbo.build/) | Monorepo task runner with caching |
| Package management | [Bun](https://bun.sh/) | All-in-one JavaScript runtime and package manager |
| Bundler | [esbuild](https://esbuild.github.io/) | Sub-second builds for server and extension |
| Type checker | [tsgo](https://github.com/nicolo-ribaudo/tc39-proposal-type-annotations) | Go-based TypeScript type checking |
| Linter | [oxc](https://oxc-project.github.io/) | Rust-based JavaScript/TypeScript linter |
| Test runner | [Vitest](https://vitest.dev/) | Fast Vite-native test runner |
| LSP framework | [vscode-languageserver](https://github.com/microsoft/vscode-languageserver-node) | Language Server Protocol implementation |
| Language | [TypeScript](https://www.typescriptlang.org/) 5.8+ | Strict mode, Node16 module resolution |
| Runtime | [Node.js](https://nodejs.org/) 22+ | Server and extension host runtime |

## License

MIT
