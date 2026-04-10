import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function assertNoSensitiveClientEnv(mode) {
  const env = loadEnv(mode, process.cwd(), "");
  const exposedKeys = Object.keys(env).filter(
    (key) => key.startsWith("VITE_") && /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CERT)/i.test(key),
  );

  if (exposedKeys.length > 0) {
    throw new Error(
      `Refusing to expose sensitive environment variables to the client bundle: ${exposedKeys.join(", ")}`,
    );
  }
}

export default defineConfig(({ mode }) => {
  assertNoSensitiveClientEnv(mode);

  return {
    plugins: [react()],
    build: {
      sourcemap: false,
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: "http://localhost:3001",
          changeOrigin: true,
        },
      },
    },
  };
});
