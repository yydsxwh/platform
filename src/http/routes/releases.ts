/**
 * Releases HTTP 层。
 *
 * 读接口按 productKey + 版本定位，供各端直接查；写接口供发版流程调用。
 */

import { Hono } from "hono";
import { z } from "zod";

import { PRODUCT_PLATFORMS } from "@yydsxwh/shared/contracts/catalog";
import {
  RELEASE_ARCHITECTURES,
  RELEASE_CHANNELS,
  RELEASE_STATUSES,
} from "@yydsxwh/shared/contracts/releases";

import type { AppEnv } from "../context";
import type { ReleaseService } from "../../modules/releases/service";
import { parseJsonBody } from "./shared";

const createReleaseSchema = z.object({
  productKey: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  channel: z.enum(RELEASE_CHANNELS),
  changelog: z.string().max(20_000).optional(),
  minimumUpgradeFrom: z.string().max(64).optional(),
});

const addAssetSchema = z.object({
  fileId: z.string().min(1),
  platform: z.enum(PRODUCT_PLATFORMS),
  architecture: z.enum(RELEASE_ARCHITECTURES),
  checksum: z.string().max(200).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

const publishSchema = z.object({
  releasedAt: z.string().datetime().optional(),
});

const downloadSchema = z.object({
  platform: z.enum(PRODUCT_PLATFORMS),
  architecture: z.enum(RELEASE_ARCHITECTURES).optional(),
  channel: z.enum(RELEASE_CHANNELS).optional(),
});

export function createReleaseRouter(deps: { releases: ReleaseService }) {
  const router = new Hono<AppEnv>();

  // 写接口放在前面：否则 /releases/:productKey 会先把 "internal" 当成产品键吃掉
  router.post("/internal/releases", async (c) => {
    const body = await parseJsonBody(createReleaseSchema, c.req.raw);
    return c.json({ release: await deps.releases.createRelease(body) }, 201);
  });

  router.post("/internal/releases/:releaseId/assets", async (c) => {
    const body = await parseJsonBody(addAssetSchema, c.req.raw);
    return c.json({
      release: await deps.releases.addAsset(c.req.param("releaseId"), body),
    });
  });

  router.post("/internal/releases/:releaseId/publish", async (c) => {
    const body = await parseJsonBody(publishSchema, c.req.raw);
    return c.json({
      release: await deps.releases.publish(c.req.param("releaseId"), body.releasedAt),
    });
  });

  router.post("/internal/releases/:releaseId/revoke", async (c) =>
    c.json({ release: await deps.releases.revoke(c.req.param("releaseId")) }),
  );

  router.get("/releases/:productKey", async (c) => {
    const query = c.req.query();
    const releases = await deps.releases.listReleases(c.req.param("productKey"), {
      channel: query.channel as never,
      platform: query.platform as never,
      status: query.status
        ? (RELEASE_STATUSES.find((s) => s === query.status) as never)
        : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return c.json({ releases });
  });

  router.get("/releases/:productKey/latest", async (c) => {
    const query = c.req.query();
    const release = await deps.releases.getLatest(c.req.param("productKey"), {
      channel: query.channel as never,
      platform: query.platform as never,
      architecture: query.architecture as never,
    });
    return c.json({ release });
  });

  router.get("/releases/:productKey/:version", async (c) =>
    c.json({
      release: await deps.releases.getVersion(
        c.req.param("productKey"),
        c.req.param("version"),
      ),
    }),
  );

  router.post("/releases/:productKey/:version/download", async (c) => {
    const body = await parseJsonBody(downloadSchema, c.req.raw);
    return c.json(
      await deps.releases.createDownload({
        productKey: c.req.param("productKey"),
        version: c.req.param("version"),
        platform: body.platform,
        architecture: body.architecture,
        channel: body.channel,
      }),
    );
  });

  return router;
}
