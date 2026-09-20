import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import type {
  CatalogProduct,
  ListCatalogResponse,
} from "@yydsxwh/shared/contracts/catalog";
import type { PlatformErrorBody } from "@yydsxwh/shared/contracts/error";

import { createTestApp, json, type TestApp } from "./helpers/app";

let ctx: TestApp;

before(async () => {
  ctx = await createTestApp();
  await upsert({
    productId: "docs",
    slug: "docs",
    name: "网页文档",
    status: "LIVE",
    supportedPlatforms: ["WEB"],
    webUrl: "https://www.yydsxwh.com/products/docs",
    sortWeight: 10,
  });
  await upsert({
    productId: "rishi",
    slug: "days",
    name: "颗秒日事",
    status: "LIVE",
    supportedPlatforms: ["WEB", "ANDROID", "WINDOWS"],
    releaseProductKey: "rishi",
    sortWeight: 20,
  });
  await upsert({
    productId: "internal-tool",
    slug: "internal-tool",
    name: "站长内部工具",
    status: "BETA",
    supportedPlatforms: ["WEB"],
    listed: false,
  });
});

after(async () => {
  await ctx.close();
});

async function upsert(body: Record<string, unknown>) {
  const res = await ctx.request(`/v1/catalog/products/${body.productId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return json<{ product: CatalogProduct }>(res);
}

test("列表默认只给已露出的产品，按权重排序", async () => {
  const res = await ctx.request("/v1/catalog/products");
  assert.equal(res.status, 200);
  const { products } = await json<ListCatalogResponse>(res);
  assert.deepEqual(
    products.map((p) => p.productId),
    ["rishi", "docs"],
  );
});

test("includeUnlisted 才能看到内部工具", async () => {
  const res = await ctx.request("/v1/catalog/products?includeUnlisted=true");
  const { products } = await json<ListCatalogResponse>(res);
  assert.ok(products.some((p) => p.productId === "internal-tool"));
});

test("按端过滤：只要安卓的产品", async () => {
  const res = await ctx.request("/v1/catalog/products?platform=ANDROID");
  const { products } = await json<ListCatalogResponse>(res);
  assert.deepEqual(
    products.map((p) => p.productId),
    ["rishi"],
  );
});

test("productId 与 slug 都能查到同一个产品", async () => {
  const byId = await json<{ product: CatalogProduct }>(
    await ctx.request("/v1/catalog/products/rishi"),
  );
  const bySlug = await json<{ product: CatalogProduct }>(
    await ctx.request("/v1/catalog/products/days"),
  );
  assert.equal(byId.product.productId, bySlug.product.productId);
  assert.equal(byId.product.releaseProductKey, "rishi");
  assert.deepEqual(byId.product.supportedPlatforms, ["WEB", "ANDROID", "WINDOWS"]);
});

test("查不到的产品返回 404", async () => {
  const res = await ctx.request("/v1/catalog/products/not-a-product");
  assert.equal(res.status, 404);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "NOT_FOUND");
});

test("重复登记是更新而不是新增，状态可以改", async () => {
  const before = await ctx.request("/v1/catalog/products?includeUnlisted=true");
  const beforeCount = (await json<ListCatalogResponse>(before)).products.length;

  const { product } = await upsert({
    productId: "docs",
    slug: "docs",
    name: "网页文档",
    status: "SUNSET",
    supportedPlatforms: ["WEB"],
    sortWeight: 10,
  });
  assert.equal(product.status, "SUNSET");

  const after = await ctx.request("/v1/catalog/products?includeUnlisted=true");
  assert.equal((await json<ListCatalogResponse>(after)).products.length, beforeCount);

  await upsert({
    productId: "docs",
    slug: "docs",
    name: "网页文档",
    status: "LIVE",
    supportedPlatforms: ["WEB"],
    sortWeight: 10,
  });
});

test("slug 被别的产品占用时要拒绝，不能悄悄改掉别人的链接", async () => {
  const res = await ctx.request("/v1/catalog/products/mathcode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId: "mathcode",
      slug: "docs",
      name: "MathCode",
      status: "LIVE",
      supportedPlatforms: ["WEB"],
    }),
  });
  assert.equal(res.status, 409);
  assert.equal((await json<PlatformErrorBody>(res)).error.code, "ALREADY_EXISTS");
});

test("非法状态与非法平台都要被参数校验挡住", async () => {
  const badStatus = await ctx.request("/v1/catalog/products/x-product", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId: "x-product",
      slug: "x-product",
      name: "X",
      status: "NOT_A_STATUS",
      supportedPlatforms: [],
    }),
  });
  assert.equal(badStatus.status, 400);

  const badPlatform = await ctx.request("/v1/catalog/products/y-product", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId: "y-product",
      slug: "y-product",
      name: "Y",
      status: "LIVE",
      supportedPlatforms: ["SYMBIAN"],
    }),
  });
  assert.equal(badPlatform.status, 400);
});

test("目录同样要服务凭证", async () => {
  const res = await ctx.request("/v1/catalog/products", { token: "" });
  assert.equal(res.status, 401);
});
