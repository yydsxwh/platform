import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import type {
  CreateDownloadUrlResponse,
  CreateUploadResponse,
  FileRecord,
  ListFilesResponse,
  NamespacePolicy,
} from "@yydsxwh/shared/contracts/storage";
import type { PlatformErrorBody } from "@yydsxwh/shared/contracts/error";

import {
  createTestApp,
  json,
  TEST_TOKEN_SOFTWARELIST,
  type TestApp,
} from "./helpers/app";

let ctx: TestApp;

before(async () => {
  ctx = await createTestApp();
});

after(async () => {
  await ctx.close();
});

async function createUpload(body: Record<string, unknown>, init: Parameters<TestApp["request"]>[1] = {}) {
  return ctx.request("/v1/storage/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

/** 走完整直传链路：申请签名 → PUT 到签名地址 → 回执 */
async function uploadFile(input: {
  namespace: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  actor?: string;
}): Promise<FileRecord> {
  const created = await createUpload(
    {
      namespace: input.namespace,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.bytes.byteLength,
    },
    input.actor ? { actor: input.actor } : {},
  );
  assert.equal(created.status, 201, await created.clone().text());
  const body = await json<CreateUploadResponse>(created);
  assert.ok(body.upload, "应下发签名上传地址");

  const put = await ctx.app.fetch(
    new Request(body.upload.url, {
      method: "PUT",
      headers: body.upload.headers,
      body: new Uint8Array(input.bytes),
    }),
  );
  assert.equal(put.status, 200, await put.clone().text());

  const completed = await ctx.request(`/v1/storage/files/${body.file.fileId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size: input.bytes.byteLength }),
  });
  assert.equal(completed.status, 200, await completed.clone().text());
  return json<FileRecord>(completed);
}

test("健康检查不需要凭证", async () => {
  const res = await ctx.request("/healthz", { token: "" });
  assert.equal(res.status, 200);
});

test("没有服务凭证一律 401，且返回统一错误体", async () => {
  const res = await ctx.request("/v1/storage/namespaces/images", { token: "" });
  assert.equal(res.status, 401);
  const body = await json<PlatformErrorBody>(res);
  assert.equal(body.error.code, "UNAUTHENTICATED");
  assert.ok(body.requestId);
});

test("凭证错误不会被当成合法调用方", async () => {
  const res = await ctx.request("/v1/storage/namespaces/images", { token: "wrong-token-x" });
  assert.equal(res.status, 401);
});

test("namespace 策略可查，未登记的 namespace 返回 404", async () => {
  const ok = await ctx.request("/v1/storage/namespaces/media");
  assert.equal(ok.status, 200);
  const policy = await json<NamespacePolicy>(ok);
  assert.equal(policy.namespace, "media");
  assert.equal(policy.allowDirectUpload, true);
  assert.equal(policy.maxBytes, 2 * 1024 * 1024 * 1024);

  const missing = await ctx.request("/v1/storage/namespaces/not-registered");
  assert.equal(missing.status, 404);
  assert.equal((await json<PlatformErrorBody>(missing)).error.code, "NOT_FOUND");
});

test("namespace 有调用方白名单时越界要 403", async () => {
  const res = await createUpload(
    { namespace: "decorate", fileName: "a.png", mimeType: "image/png", size: 10 },
    { token: TEST_TOKEN_SOFTWARELIST },
  );
  assert.equal(res.status, 403);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "PERMISSION_DENIED");
});

test("完整直传：签名上传、回执、下载都能跑通", async () => {
  const bytes = Buffer.from("hello platform storage");
  const file = await uploadFile({
    namespace: "images",
    fileName: "cover.png",
    mimeType: "image/png",
    bytes,
    actor: "user_1",
  });

  assert.equal(file.status, "READY");
  assert.equal(file.size, bytes.byteLength);
  assert.equal(file.ownerId, "user_1");
  assert.equal(file.clientId, "andyyyds");
  assert.match(file.key, /^images\/\d{4}\/\d{2}\/file_[0-9a-f]+-cover\.png$/);

  const urlRes = await ctx.request(`/v1/storage/files/${file.fileId}/download-url`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expiresInSeconds: 600 }),
  });
  assert.equal(urlRes.status, 200);
  const download = await json<CreateDownloadUrlResponse>(urlRes);
  assert.equal(download.signed, true);

  const fetched = await ctx.app.fetch(new Request(download.url));
  assert.equal(fetched.status, 200);
  assert.equal(Buffer.from(await fetched.arrayBuffer()).toString(), bytes.toString());
});

test("签名被篡改要 403，不能靠改 URL 拿到别人的对象", async () => {
  const file = await uploadFile({
    namespace: "images",
    fileName: "x.png",
    mimeType: "image/png",
    bytes: Buffer.from("abc"),
  });
  const urlRes = await ctx.request(`/v1/storage/files/${file.fileId}/download-url`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const { url } = await json<CreateDownloadUrlResponse>(urlRes);

  const tampered = new URL(url);
  tampered.searchParams.set("signature", "0".repeat(64));
  const res = await ctx.app.fetch(new Request(tampered.toString()));
  assert.equal(res.status, 403);
});

test("过期签名不再放行", async () => {
  const file = await uploadFile({
    namespace: "images",
    fileName: "y.png",
    mimeType: "image/png",
    bytes: Buffer.from("abc"),
  });
  const urlRes = await ctx.request(`/v1/storage/files/${file.fileId}/download-url`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const { url } = await json<CreateDownloadUrlResponse>(urlRes);

  const expired = new URL(url);
  expired.searchParams.set("expires", "1");
  const res = await ctx.app.fetch(new Request(expired.toString()));
  assert.equal(res.status, 403);
});

test("超出 namespace 上限的文件在申请阶段就被拒", async () => {
  const res = await createUpload({
    namespace: "avatars",
    fileName: "big.png",
    mimeType: "image/png",
    size: 50 * 1024 * 1024,
  });
  assert.equal(res.status, 413);
  const body = await json<PlatformErrorBody>(res);
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal((body.error.details as { maxBytes: number }).maxBytes, 5 * 1024 * 1024);
});

test("非法 MIME 被拒，可执行文件进不了图片 namespace", async () => {
  const res = await createUpload({
    namespace: "images",
    fileName: "evil.exe",
    mimeType: "application/x-msdownload",
    size: 1024,
  });
  assert.equal(res.status, 415);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("没上传字节就回执，文件保持 PENDING 而不是变成下不动的幽灵文件", async () => {
  const created = await createUpload({
    namespace: "images",
    fileName: "ghost.png",
    mimeType: "image/png",
    size: 10,
  });
  const body = await json<CreateUploadResponse>(created);

  const completed = await ctx.request(`/v1/storage/files/${body.file.fileId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(completed.status, 412);
  assert.equal((await json<PlatformErrorBody>(completed)).error.code, "FAILED_PRECONDITION");

  const still = await ctx.request(`/v1/storage/files/${body.file.fileId}`);
  assert.equal((await json<FileRecord>(still)).status, "PENDING");
});

test("PENDING 文件取不到下载链接", async () => {
  const created = await createUpload({
    namespace: "images",
    fileName: "pending.png",
    mimeType: "image/png",
    size: 10,
  });
  const body = await json<CreateUploadResponse>(created);
  const res = await ctx.request(`/v1/storage/files/${body.file.fileId}/download-url`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 412);
});

test("申报大小与实际字节不符要拒绝回执", async () => {
  const created = await createUpload({
    namespace: "images",
    fileName: "mismatch.png",
    mimeType: "image/png",
    size: 100,
  });
  const body = await json<CreateUploadResponse>(created);
  await ctx.app.fetch(
    new Request(body.upload!.url, { method: "PUT", body: new Uint8Array(Buffer.from("short")) }),
  );

  const completed = await ctx.request(`/v1/storage/files/${body.file.fileId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size: 100 }),
  });
  assert.equal(completed.status, 400);
  assert.equal((await json<PlatformErrorBody>(completed)).error.code, "INVALID_REQUEST");
});

test("不存在的文件返回 404", async () => {
  const res = await ctx.request("/v1/storage/files/file_does_not_exist");
  assert.equal(res.status, 404);
});

test("跨调用方读别人的文件按不存在处理，不泄露 fileId 是否有效", async () => {
  const file = await uploadFile({
    namespace: "images",
    fileName: "private.png",
    mimeType: "image/png",
    bytes: Buffer.from("secret"),
  });
  const res = await ctx.request(`/v1/storage/files/${file.fileId}`, {
    token: TEST_TOKEN_SOFTWARELIST,
  });
  assert.equal(res.status, 404);
});

test("服务端代传小文件可用，超过软上限要求改直传", async () => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(Buffer.from("avatar-bytes"))], "me.png", { type: "image/png" }));
  form.set("namespace", "avatars");
  form.set("ownerId", "user_9");
  const res = await ctx.request("/v1/storage/files", { method: "POST", body: form });
  assert.equal(res.status, 201, await res.clone().text());
  const record = await json<FileRecord>(res);
  assert.equal(record.status, "READY");
  assert.equal(record.visibility, "PUBLIC");
  assert.equal(record.ownerId, "user_9");

  const big = new FormData();
  big.set(
    "file",
    new File([new Uint8Array(9 * 1024 * 1024)], "big.png", { type: "image/png" }),
  );
  big.set("namespace", "images");
  const tooBig = await ctx.request("/v1/storage/files", { method: "POST", body: big });
  assert.equal(tooBig.status, 413);
});

test("分片直传：签片、传片、合并、下载", async () => {
  const partSize = 5 * 1024 * 1024;
  const part1 = Buffer.alloc(partSize, 1);
  const part2 = Buffer.from("tail");
  const total = part1.byteLength + part2.byteLength;

  const created = await createUpload({
    namespace: "media",
    fileName: "lecture.mp4",
    mimeType: "video/mp4",
    size: total,
    multipart: true,
  });
  assert.equal(created.status, 201);
  const body = await json<CreateUploadResponse>(created);
  assert.equal(body.upload, null, "分片上传不下发单条 PUT 地址");
  assert.ok(body.multipart);
  const { uploadId } = body.multipart;

  const signed = await ctx.request(
    `/v1/storage/files/${body.file.fileId}/multipart/parts`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId, partNumbers: [1, 2] }),
    },
  );
  assert.equal(signed.status, 200, await signed.clone().text());
  const { parts } = await json<{ parts: Array<{ partNumber: number; url: string }> }>(signed);

  const etags: Array<{ partNumber: number; etag: string }> = [];
  for (const [index, chunk] of [part1, part2].entries()) {
    const target = parts.find((p) => p.partNumber === index + 1)!;
    const res = await ctx.app.fetch(
      new Request(target.url, { method: "PUT", body: new Uint8Array(chunk) }),
    );
    assert.equal(res.status, 200);
    etags.push({ partNumber: index + 1, etag: res.headers.get("etag")!.replace(/"/g, "") });
  }

  const done = await ctx.request(
    `/v1/storage/files/${body.file.fileId}/multipart/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId, parts: etags }),
    },
  );
  assert.equal(done.status, 200, await done.clone().text());
  const record = await json<FileRecord>(done);
  assert.equal(record.status, "READY");
  assert.equal(record.size, total);
});

test("uploadId 对不上要拒绝签片", async () => {
  const created = await createUpload({
    namespace: "media",
    fileName: "a.mp4",
    mimeType: "video/mp4",
    size: 1024,
    multipart: true,
  });
  const body = await json<CreateUploadResponse>(created);
  const res = await ctx.request(`/v1/storage/files/${body.file.fileId}/multipart/parts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: "not-the-right-one", partNumbers: [1] }),
  });
  assert.equal(res.status, 412);
});

test("列表只返回本调用方的文件，且支持按 namespace 过滤", async () => {
  const res = await ctx.request("/v1/storage/files?namespace=images&limit=100");
  const list = await json<ListFilesResponse>(res);
  assert.ok(list.files.length > 0);
  assert.ok(list.files.every((f) => f.clientId === "andyyyds"));
  assert.ok(list.files.every((f) => f.namespace === "images"));
});

test("删除后再取按不存在处理，重复删除不报错", async () => {
  const file = await uploadFile({
    namespace: "images",
    fileName: "gone.png",
    mimeType: "image/png",
    bytes: Buffer.from("bye"),
  });
  assert.equal((await ctx.request(`/v1/storage/files/${file.fileId}`, { method: "DELETE" })).status, 204);
  assert.equal((await ctx.request(`/v1/storage/files/${file.fileId}`)).status, 404);
  assert.equal((await ctx.request(`/v1/storage/files/${file.fileId}`, { method: "DELETE" })).status, 404);
});

test("请求体不是 JSON 时给明确的 400，而不是 500", async () => {
  const res = await ctx.request("/v1/storage/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ 坏 json",
  });
  assert.equal(res.status, 400);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "INVALID_REQUEST");
});

test("未知路由也返回统一错误体", async () => {
  const res = await ctx.request("/v1/storage/nope");
  assert.equal(res.status, 404);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "NOT_FOUND");
});
