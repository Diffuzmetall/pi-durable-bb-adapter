import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["apps/server/test/threads/native-existing-daemon.test.ts"], testTimeout: 25000, fileParallelism: false, maxWorkers: 1 } });
