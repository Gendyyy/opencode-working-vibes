// Root entrypoint shim so OpenCode's `plugins/` directory discovery can load the
// package without reading package.json exports.
export { default } from "./src/index.js";
