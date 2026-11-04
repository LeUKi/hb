// capjs-core loads esbuild and javascript-obfuscator on demand, only for its
// heaviest obfuscation levels, and goes without them when the import fails.
// Neither runs in Workers, so the bundle maps both here (wrangler.*.jsonc).
throw new Error("NOT_AVAILABLE_IN_WORKERS");
