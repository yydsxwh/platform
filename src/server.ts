/**
 * 进程入口。配置不合法就在启动时失败，不要带病上线。
 */

import { serve } from "@hono/node-server";
import { config as loadEnvFile } from "dotenv";
import { PrismaClient } from "@prisma/client";

import { buildApp } from "./app";
import { loadConfig } from "./config";

loadEnvFile();

const config = loadConfig();
const db = new PrismaClient();
const { app } = buildApp({ config, db });

const server = serve({ fetch: app.fetch, port: config.env.PORT }, (info) => {
  console.log(
    `[platform] 监听 ${info.port}，存储后端 ${config.env.STORAGE_DEFAULT_PROVIDER}`,
  );
});

async function shutdown(signal: string) {
  console.log(`[platform] 收到 ${signal}，开始退出`);
  server.close();
  await db.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
