// esbuild alias target for app-root-path (see build-bundles.mjs): the real
// package is CJS that calls a global __dirname at its module top level, which
// Node refuses in an ESM file that also has top-level await
// (ERR_AMBIGUOUS_MODULE_SYNTAX). typeorm only reads the .path property, so
// process.cwd() is a faithful stand-in.
export default { path: process.cwd() }
