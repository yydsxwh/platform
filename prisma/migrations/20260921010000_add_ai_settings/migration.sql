-- 增量迁移：只新增两张表，不改动既有列，回滚执行文末的 DROP 即可。
-- CreateTable
CREATE TABLE "AiProviderSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL,
    "apiKeyCipher" TEXT,
    "models" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiRouteSetting" (
    "purpose" TEXT NOT NULL PRIMARY KEY,
    "candidates" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);

-- 回滚：
--   DROP TABLE "AiRouteSetting";
--   DROP TABLE "AiProviderSetting";
