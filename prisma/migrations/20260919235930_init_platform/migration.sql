-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "visibility" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ownerId" TEXT,
    "clientId" TEXT NOT NULL,
    "checksum" TEXT,
    "labels" TEXT NOT NULL DEFAULT '{}',
    "uploadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "webUrl" TEXT,
    "iconUrl" TEXT,
    "supportedPlatforms" TEXT NOT NULL DEFAULT '[]',
    "releaseProductKey" TEXT,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "sortWeight" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "releasedAt" DATETIME,
    "changelog" TEXT NOT NULL DEFAULT '',
    "minimumUpgradeFrom" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReleaseAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "releaseId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "architecture" TEXT NOT NULL,
    "checksum" TEXT,
    "labels" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReleaseAsset_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReleaseAsset_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientOrderNo" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payerId" TEXT,
    "payerOpenId" TEXT,
    "providerTransactionId" TEXT,
    "returnUrl" TEXT,
    "paidAt" DATETIME,
    "expiresAt" DATETIME,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "clientRefundNo" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "File_clientId_namespace_status_idx" ON "File"("clientId", "namespace", "status");

-- CreateIndex
CREATE INDEX "File_ownerId_idx" ON "File"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "File_provider_objectKey_key" ON "File"("provider", "objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProduct_slug_key" ON "CatalogProduct"("slug");

-- CreateIndex
CREATE INDEX "CatalogProduct_status_listed_idx" ON "CatalogProduct"("status", "listed");

-- CreateIndex
CREATE INDEX "Release_productKey_channel_status_idx" ON "Release"("productKey", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Release_productKey_channel_version_key" ON "Release"("productKey", "channel", "version");

-- CreateIndex
CREATE INDEX "ReleaseAsset_fileId_idx" ON "ReleaseAsset"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseAsset_releaseId_platform_architecture_key" ON "ReleaseAsset"("releaseId", "platform", "architecture");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_providerTransactionId_idx" ON "Payment"("providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_clientId_clientOrderNo_key" ON "Payment"("clientId", "clientOrderNo");

-- CreateIndex
CREATE INDEX "PaymentEvent_paymentId_idx" ON "PaymentEvent"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_provider_providerEventId_key" ON "PaymentEvent"("provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paymentId_clientRefundNo_key" ON "Refund"("paymentId", "clientRefundNo");
