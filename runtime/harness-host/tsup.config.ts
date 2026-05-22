import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/opencode-runtime-mcp-server.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  splitting: false,
  platform: "node",
  target: "node20",
  sourcemap: true,
  dts: true,
  outExtension() {
    return {
      js: ".mjs"
    };
  }
});
