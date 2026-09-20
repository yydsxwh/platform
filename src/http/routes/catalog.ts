/** Catalog HTTP 层 */

import { Hono } from "hono";
import { z } from "zod";

import {
  CATALOG_PRODUCT_STATUSES,
  PRODUCT_PLATFORMS,
} from "@yydsxwh/shared/contracts/catalog";

import type { AppEnv } from "../context";
import type { CatalogService } from "../../modules/catalog/service";
import { parseJsonBody } from "./shared";

const upsertSchema = z.object({
  productId: z.string().min(2).max(64),
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  tagline: z.string().max(200).optional(),
  status: z.enum(CATALOG_PRODUCT_STATUSES),
  webUrl: z.string().url().nullable().optional(),
  iconUrl: z.string().url().nullable().optional(),
  supportedPlatforms: z.array(z.enum(PRODUCT_PLATFORMS)).default([]),
  releaseProductKey: z.string().max(64).nullable().optional(),
  listed: z.boolean().optional(),
  sortWeight: z.number().int().optional(),
});

export function createCatalogRouter(deps: { catalog: CatalogService }) {
  const router = new Hono<AppEnv>();

  router.get("/products", async (c) => {
    const query = c.req.query();
    const products = await deps.catalog.listProducts({
      status: query.status as never,
      platform: query.platform as never,
      includeUnlisted: query.includeUnlisted === "true",
    });
    return c.json({ products });
  });

  router.get("/products/:idOrSlug", async (c) =>
    c.json({ product: await deps.catalog.getProduct(c.req.param("idOrSlug")) }),
  );

  router.put("/products/:productId", async (c) => {
    const body = await parseJsonBody(upsertSchema, c.req.raw, {
      productId: c.req.param("productId"),
    });
    return c.json({ product: await deps.catalog.upsertProduct(body) });
  });

  return router;
}
