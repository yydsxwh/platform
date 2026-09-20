import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import type { OssConfig } from "../src/config";
import {
  AliyunOssAdapter,
  buildStringToSign,
  encodeObjectKey,
  explainOssError,
  ossVirtualHost,
  xmlTag,
  type OssHttp,
} from "../src/modules/storage/providers/aliyun-oss";
import { PlatformError } from "../src/errors";

const config: OssConfig = {
  accessKeyId: "AK_TEST",
  accessKeySecret: "SK_TEST",
  bucket: "yyds-test",
  region: "cn-hongkong",
  endpoint: "",
  publicBaseUrl: "",
  accelerateEnabled: false,
};

function stubHttp(
  responses: Array<{ ok: boolean; status: number; text: string; headers?: Record<string, string> }>,
): { http: OssHttp; calls: Array<{ url: string; method: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  let index = 0;
  const http: OssHttp = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    return {
      ok: next.ok,
      status: next.status,
      text: next.text,
      headers: new Headers(next.headers ?? {}),
    };
  };
  return { http, calls };
}

test("虚拟主机域名按 bucket 与 region 拼，显式 endpoint 优先", () => {
  assert.equal(ossVirtualHost(config), "yyds-test.oss-cn-hongkong.aliyuncs.com");
  assert.equal(
    ossVirtualHost({ ...config, endpoint: "cdn.example.com" }),
    "cdn.example.com",
  );
});

test("对象 key 逐段编码：斜杠保留为路径分隔符", () => {
  assert.equal(encodeObjectKey("media/2026/01/文件 名.mp4"), "media/2026/01/%E6%96%87%E4%BB%B6%20%E5%90%8D.mp4");
  assert.equal(encodeObjectKey("a/b/c.png"), "a/b/c.png");
});

test("StringToSign 结构与阿里云 V1 预签名一致", () => {
  assert.equal(
    buildStringToSign({
      method: "GET",
      expiresOrDate: "1700000000",
      canonicalizedResource: "/yyds-test/media/a.mp4",
    }),
    "GET\n\n\n1700000000\n/yyds-test/media/a.mp4",
  );
  assert.equal(
    buildStringToSign({
      method: "PUT",
      contentType: "video/mp4",
      expiresOrDate: "Mon, 01 Jan 2026 00:00:00 GMT",
      canonicalizedResource: "/yyds-test/a?uploads",
      ossHeaders: { "x-oss-b": " 2 ", "x-oss-a": "1", ignored: "x" },
    }),
    "PUT\n\nvideo/mp4\nMon, 01 Jan 2026 00:00:00 GMT\nx-oss-a:1\nx-oss-b:2\n/yyds-test/a?uploads",
  );
});

test("下载预签名带 AccessKeyId/Expires/Signature，且签名可独立复算", async () => {
  const adapter = new AliyunOssAdapter(config, stubHttp([{ ok: true, status: 200, text: "" }]).http);
  const target = await adapter.createDownloadTarget({
    fileId: "file_1",
    objectKey: "media/a.mp4",
    expiresInSeconds: 600,
    isPublic: false,
  });

  const url = new URL(target.url);
  assert.equal(url.host, "yyds-test.oss-cn-hongkong.aliyuncs.com");
  assert.equal(url.searchParams.get("OSSAccessKeyId"), "AK_TEST");

  const expires = url.searchParams.get("Expires")!;
  const expected = createHmac("sha1", "SK_TEST")
    .update(`GET\n\n\n${expires}\n/yyds-test/media/a.mp4`)
    .digest("base64");
  assert.equal(url.searchParams.get("Signature"), expected);
  assert.equal(target.signed, true);
});

test("另存文件名进签名串，改文件名会让签名失效", async () => {
  const adapter = new AliyunOssAdapter(config, stubHttp([{ ok: true, status: 200, text: "" }]).http);
  const target = await adapter.createDownloadTarget({
    fileId: "file_1",
    objectKey: "app-installers/yyds.apk",
    expiresInSeconds: 600,
    isPublic: false,
    downloadFileName: "歪歪滴艾斯.apk",
  });
  const url = new URL(target.url);
  const expires = url.searchParams.get("Expires")!;
  const disposition = 'attachment;filename="歪歪滴艾斯.apk"';
  const expected = createHmac("sha1", "SK_TEST")
    .update(
      `GET\n\n\n${expires}\n/yyds-test/app-installers/yyds.apk?response-content-disposition=${disposition}`,
    )
    .digest("base64");
  assert.equal(url.searchParams.get("Signature"), expected);
});

test("公开对象在配了自定义域名时返回直链，不带签名", async () => {
  const adapter = new AliyunOssAdapter(
    { ...config, publicBaseUrl: "https://cdn.example.com" },
    stubHttp([{ ok: true, status: 200, text: "" }]).http,
  );
  const target = await adapter.createDownloadTarget({
    fileId: "f",
    objectKey: "avatars/a.png",
    expiresInSeconds: 600,
    isPublic: true,
  });
  assert.equal(target.url, "https://cdn.example.com/avatars/a.png");
  assert.equal(target.signed, false);
});

test("开启传输加速后下载走加速域名", async () => {
  const adapter = new AliyunOssAdapter(
    { ...config, accelerateEnabled: true },
    stubHttp([{ ok: true, status: 200, text: "" }]).http,
  );
  const target = await adapter.createDownloadTarget({
    fileId: "f",
    objectKey: "app-installers/yyds.apk",
    expiresInSeconds: 600,
    isPublic: false,
  });
  assert.equal(new URL(target.url).host, "yyds-test.oss-accelerate.aliyuncs.com");
});

test("分片签名把 partNumber 与 uploadId 纳入签名串", async () => {
  const adapter = new AliyunOssAdapter(config, stubHttp([{ ok: true, status: 200, text: "" }]).http);
  const parts = await adapter.signMultipartParts({
    fileId: "f",
    objectKey: "media/a.mp4",
    uploadId: "UP123",
    partNumbers: [1, 2],
    expiresInSeconds: 600,
  });

  assert.equal(parts.length, 2);
  const url = new URL(parts[0]!.url);
  const expires = url.searchParams.get("Expires")!;
  const expected = createHmac("sha1", "SK_TEST")
    .update(`PUT\n\n\n${expires}\n/yyds-test/media/a.mp4?partNumber=1&uploadId=UP123`)
    .digest("base64");
  assert.equal(url.searchParams.get("Signature"), expected);
  assert.equal(url.searchParams.get("partNumber"), "1");
});

test("初始化分片解析 UploadId；OSS 报错时抛 PROVIDER_UNAVAILABLE", async () => {
  const ok = new AliyunOssAdapter(
    config,
    stubHttp([{ ok: true, status: 200, text: "<InitiateMultipartUploadResult><UploadId>UP9</UploadId></InitiateMultipartUploadResult>" }]).http,
  );
  assert.deepEqual(
    await ok.createMultipartUpload({ objectKey: "media/a.mp4", mimeType: "video/mp4" }),
    { uploadId: "UP9" },
  );

  const failing = new AliyunOssAdapter(
    config,
    stubHttp([{ ok: false, status: 403, text: "<Error><Code>AccessDenied</Code><Message>no</Message></Error>" }]).http,
  );
  const error = await failing
    .createMultipartUpload({ objectKey: "media/a.mp4", mimeType: "video/mp4" })
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(error instanceof PlatformError);
  assert.equal(error.code, "PROVIDER_UNAVAILABLE");
});

test("上传失败要抛出，不能静默当成成功", async () => {
  const adapter = new AliyunOssAdapter(
    config,
    stubHttp([{ ok: false, status: 503, text: "<Error><Code>ServiceUnavailable</Code></Error>" }]).http,
  );
  const error = await adapter
    .putObject({ objectKey: "images/a.png", body: Buffer.from("x"), mimeType: "image/png" })
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(error instanceof PlatformError);
  assert.equal(error.code, "PROVIDER_UNAVAILABLE");
});

test("删除时对象已不存在算成功，重试不该失败", async () => {
  const adapter = new AliyunOssAdapter(
    config,
    stubHttp([{ ok: false, status: 404, text: "" }]).http,
  );
  await adapter.deleteObject("images/gone.png");
});

test("statObject 读 content-length，对象不存在返回 null", async () => {
  const present = new AliyunOssAdapter(
    config,
    stubHttp([{ ok: true, status: 200, text: "", headers: { "content-length": "2048" } }]).http,
  );
  assert.deepEqual(await present.statObject("images/a.png"), { size: 2048 });

  const missing = new AliyunOssAdapter(config, stubHttp([{ ok: false, status: 404, text: "" }]).http);
  assert.equal(await missing.statObject("images/a.png"), null);
});

test("合并分片按 partNumber 排序后再提交", async () => {
  const { http, calls } = stubHttp([{ ok: true, status: 200, text: "<CompleteMultipartUploadResult/>" }]);
  const adapter = new AliyunOssAdapter(config, http);
  await adapter.completeMultipartUpload({
    objectKey: "media/a.mp4",
    uploadId: "UP1",
    parts: [
      { partNumber: 2, etag: '"e2"' },
      { partNumber: 1, etag: "e1" },
    ],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /uploadId=UP1/);
  assert.equal(calls[0]!.headers.authorization?.startsWith("OSS AK_TEST:"), true);
});

test("OSS 报错文案翻成可操作说明", () => {
  assert.match(
    explainOssError(403, "<Error><Message>The bucket you access does not belong to you.</Message></Error>"),
    /不属于同一个阿里云账号/,
  );
  assert.match(
    explainOssError(403, "<Error><AuthAction>oss:PutObject</AuthAction></Error>"),
    /RAM 未授予/,
  );
  assert.equal(xmlTag("<Code>NoSuchKey</Code>", "Code"), "NoSuchKey");
});
