import { defineConfig } from "vitest/config";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/**",
        "src-tauri/**",
        "**/*.config.ts",
        "**/types.ts",
        "**/*.d.ts",
      ],
    },
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
