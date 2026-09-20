import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import type { PlatformErrorBody } from "@yydsxwh/shared/contracts/error";
import type {
  ListReleasesResponse,
  Release,
  ReleaseDownloadResponse,
} from "@yydsxwh/shared/contracts/releases";
import type {
  CreateUploadResponse,
  FileRecord,
} from "@yydsxwh/shared/contracts/storage";

import { createTestApp, json, type TestApp } from "./helpers/app";

let ctx: TestApp;

before(async () => {
  ctx = await createTestApp();
});

after(async () => {
  await ctx.close();
});

/** 传一个安装包到 app-installers，返回 fileId */
async function uploadInstaller(fileName: string, mimeType: string): Promise<FileRecord> {
  const bytes = Buffer.from(`installer-${fileName}`);
  const created = await ctx.request("/v1/storage/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      namespace: "app-installers",
      fileName,
      mimeType,
      size: bytes.byteLength,
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const body = await json<CreateUploadResponse>(created);
  await ctx.app.fetch(
    new Request(body.upload!.url, { method: "PUT", body: new Uint8Array(bytes) }),
  );
  const done = await ctx.request(`/v1/storage/files/${body.file.fileId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size: bytes.byteLength }),
  });
  assert.equal(done.status, 200);
  return json<FileRecord>(done);
}

async function createRelease(body: Record<string, unknown>): Promise<Release> {
  const res = await ctx.request("/v1/internal/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await json<{ release: Release }>(res)).release;
}

async function addAsset(releaseId: string, body: Record<string, unknown>) {
  const res = await ctx.request(`/v1/internal/releases/${releaseId}/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

async function publish(releaseId: string) {
  const res = await ctx.request(`/v1/internal/releases/${releaseId}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return res;
}

test("发版流程：建草稿、挂安装包、发布", async () => {
  const release = await createRelease({
    productKey: "rishi",
    version: "1.0.0",
    channel: "STABLE",
    changelog: "首个正式版",
  });
  assert.equal(release.status, "DRAFT");

  const apk = await uploadInstaller("kemiao-days.apk", "application/vnd.android.package-archive");
  const exe = await uploadInstaller("kemiao-days-setup.exe", "application/x-msdownload");

  assert.equal(
    (await addAsset(release.releaseId, {
      fileId: apk.fileId,
      platform: "ANDROID",
      architecture: "UNIVERSAL",
      labels: { versionCode: "100" },
    })).status,
    200,
  );
  assert.equal(
    (await addAsset(release.releaseId, {
      fileId: exe.fileId,
      platform: "WINDOWS",
      architecture: "X64",
    })).status,
    200,
  );

  const published = (await json<{ release: Release }>(await publish(release.releaseId))).release;
  assert.equal(published.status, "PUBLISHED");
  assert.ok(published.releasedAt);
  assert.equal(published.assets.length, 2);
  assert.equal(published.assets.find((a) => a.platform === "ANDROID")!.fileName, "kemiao-days.apk");
});

test("没有安装包不能发布，免得发出去点下载是 404", async () => {
  const release = await createRelease({
    productKey: "empty-product",
    version: "0.1.0",
    channel: "STABLE",
  });
  const res = await publish(release.releaseId);
  assert.equal(res.status, 412);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "FAILED_PRECONDITION");
});

test("同一产品同通道的版本号唯一", async () => {
  const res = await ctx.request("/v1/internal/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productKey: "rishi", version: "1.0.0", channel: "STABLE" }),
  });
  assert.equal(res.status, 409);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "ALREADY_EXISTS");
});

test("版本号必须是语义化版本", async () => {
  const res = await ctx.request("/v1/internal/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productKey: "rishi", version: "最新版", channel: "STABLE" }),
  });
  assert.equal(res.status, 400);
});

test("latest 取最新已发布版本，不同通道互不干扰", async () => {
  const beta = await createRelease({ productKey: "rishi", version: "1.1.0", channel: "BETA" });
  const apk = await uploadInstaller("kemiao-days-beta.apk", "application/vnd.android.package-archive");
  await addAsset(beta.releaseId, { fileId: apk.fileId, platform: "ANDROID", architecture: "UNIVERSAL" });
  await publish(beta.releaseId);

  const stable = await json<{ release: Release }>(
    await ctx.request("/v1/releases/rishi/latest"),
  );
  assert.equal(stable.release.version, "1.0.0");
  assert.equal(stable.release.channel, "STABLE");

  const latestBeta = await json<{ release: Release }>(
    await ctx.request("/v1/releases/rishi/latest?channel=BETA"),
  );
  assert.equal(latestBeta.release.version, "1.1.0");
});

test("latest 按端过滤：只有该端有安装包的版本才会被选中", async () => {
  const noWindows = await createRelease({
    productKey: "rishi",
    version: "1.2.0",
    channel: "STABLE",
  });
  const apk = await uploadInstaller("kemiao-days-120.apk", "application/vnd.android.package-archive");
  await addAsset(noWindows.releaseId, {
    fileId: apk.fileId,
    platform: "ANDROID",
    architecture: "UNIVERSAL",
  });
  await publish(noWindows.releaseId);

  const android = await json<{ release: Release }>(
    await ctx.request("/v1/releases/rishi/latest?platform=ANDROID"),
  );
  assert.equal(android.release.version, "1.2.0");

  // 1.2.0 没有 Windows 包，应回落到仍有 Windows 包的 1.0.0
  const windows = await json<{ release: Release }>(
    await ctx.request("/v1/releases/rishi/latest?platform=WINDOWS"),
  );
  assert.equal(windows.release.version, "1.0.0");
});

test("没有任何已发布版本时 latest 返回 404，让前端显示「准备中」", async () => {
  const res = await ctx.request("/v1/releases/never-published/latest");
  assert.equal(res.status, 404);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "NOT_FOUND");
});

test("可以按版本号精确取，不存在的版本 404", async () => {
  const ok = await ctx.request("/v1/releases/rishi/1.0.0");
  assert.equal(ok.status, 200);
  assert.equal((await json<{ release: Release }>(ok)).release.version, "1.0.0");

  const missing = await ctx.request("/v1/releases/rishi/9.9.9");
  assert.equal(missing.status, 404);
});

test("下载换短期签名链接，文件名来自安装包本身", async () => {
  const res = await ctx.request("/v1/releases/rishi/latest/download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "ANDROID" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json<ReleaseDownloadResponse>(res);
  assert.equal(body.asset.platform, "ANDROID");
  assert.ok(body.url.includes("signature="));
  assert.ok(new Date(body.expiresAt).getTime() > Date.now());

  // 链接真的能下到字节
  const fetched = await ctx.app.fetch(new Request(body.url));
  assert.equal(fetched.status, 200);
});

test("该端没有安装包时下载返回 404，而不是给一个坏链接", async () => {
  const res = await ctx.request("/v1/releases/rishi/1.2.0/download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "IOS" }),
  });
  assert.equal(res.status, 404);
});

test("撤回后 latest 跳过该版本，但按版本号仍可查到", async () => {
  const release = await createRelease({
    productKey: "revoke-me",
    version: "2.0.0",
    channel: "STABLE",
  });
  const apk = await uploadInstaller("revoke.apk", "application/vnd.android.package-archive");
  await addAsset(release.releaseId, {
    fileId: apk.fileId,
    platform: "ANDROID",
    architecture: "UNIVERSAL",
  });
  await publish(release.releaseId);
  assert.equal((await ctx.request("/v1/releases/revoke-me/latest")).status, 200);

  const revoked = await ctx.request(`/v1/internal/releases/${release.releaseId}/revoke`, {
    method: "POST",
  });
  assert.equal(revoked.status, 200);
  assert.equal((await ctx.request("/v1/releases/revoke-me/latest")).status, 404);

  const byVersion = await ctx.request("/v1/releases/revoke-me/2.0.0");
  assert.equal(byVersion.status, 200);
  assert.equal((await json<{ release: Release }>(byVersion)).release.status, "REVOKED");
});

test("同一端同一架构不能重复挂包", async () => {
  const release = await createRelease({
    productKey: "dup-product",
    version: "1.0.0",
    channel: "STABLE",
  });
  const apk = await uploadInstaller("dup.apk", "application/vnd.android.package-archive");
  assert.equal(
    (await addAsset(release.releaseId, {
      fileId: apk.fileId,
      platform: "ANDROID",
      architecture: "UNIVERSAL",
    })).status,
    200,
  );
  const again = await addAsset(release.releaseId, {
    fileId: apk.fileId,
    platform: "ANDROID",
    architecture: "UNIVERSAL",
  });
  assert.equal(again.status, 409);
});

test("挂一个不存在的 fileId 要 404，不能产生指向空气的版本", async () => {
  const release = await createRelease({
    productKey: "ghost-asset",
    version: "1.0.0",
    channel: "STABLE",
  });
  const res = await addAsset(release.releaseId, {
    fileId: "file_not_real",
    platform: "ANDROID",
    architecture: "UNIVERSAL",
  });
  assert.equal(res.status, 404);
});

test("尚未上传完成的文件不能作为安装包", async () => {
  const created = await ctx.request("/v1/storage/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      namespace: "app-installers",
      fileName: "pending.apk",
      mimeType: "application/vnd.android.package-archive",
      size: 100,
    }),
  });
  const pending = await json<CreateUploadResponse>(created);
  const release = await createRelease({
    productKey: "pending-asset",
    version: "1.0.0",
    channel: "STABLE",
  });
  const res = await addAsset(release.releaseId, {
    fileId: pending.file.fileId,
    platform: "ANDROID",
    architecture: "UNIVERSAL",
  });
  assert.equal(res.status, 412);
});

test("列表默认只给已发布版本", async () => {
  const res = await ctx.request("/v1/releases/rishi");
  const { releases } = await json<ListReleasesResponse>(res);
  assert.ok(releases.length >= 2);
  assert.ok(releases.every((r) => r.status === "PUBLISHED"));
});
