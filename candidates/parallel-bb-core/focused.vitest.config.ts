import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["apps/server/test/threads/native-existing-handler.test.ts"], testTimeout: 30000, fileParallelism: false, maxWorkers: 1 } });
