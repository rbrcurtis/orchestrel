import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ isSsrBuild }) => ({
  build: {
    rollupOptions: isSsrBuild
      ? {
          input: "./server/app.ts",
        }
      : undefined,
  },
  server: {
    port: 6194,
    host: '192.168.4.200',
    allowedHosts: ['dispatch.rbrcurtis.com'],
  },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
}));
