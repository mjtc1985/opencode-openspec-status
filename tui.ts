// OpenCode 2 entry point. For a plugin given as a local folder, OpenCode 2 loads
// `<folder>/tui`, while OpenCode 1 follows the `./tui` export in package.json
// (src/tui.tsx). Keeping both lets the same folder work in either version.
export { default } from "./src/opencode-2.tsx"
