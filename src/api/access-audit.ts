import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../platform/context.js";
import { audit } from "../services/audit.js";
import type { Principal } from "../services/auth.js";

/**
 * Successful reads of evidence leave an audit row (who, which resource, which format): the manifest download, the run export
 * (json and html) and the run bundle. Only a 200 answer is recorded, after it has been sent, so a refused or failed request
 * leaves nothing; the row holds no content and no address. Login and logout are audited by the auth service itself.
 */
const ROUTES: Record<string, { action: string; resourceType: string }> = {
  "/api/v1/snapshots/:id/manifest": { action: "snapshot.manifest_downloaded", resourceType: "snapshot" },
  "/api/v1/impact-runs/:id/export": { action: "impact_run.exported", resourceType: "impact_run" },
  "/api/v1/impact-runs/:id/bundle": { action: "impact_run.bundle_downloaded", resourceType: "impact_run" },
};

export function registerAccessAudit(app: FastifyInstance, ctx: Ctx, who: (req: FastifyRequest) => Principal): void {
  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const route = ROUTES[req.routeOptions?.url ?? ""];
    if (!route || req.method !== "GET" || reply.statusCode !== 200) return;
    const principal = who(req);
    const params = req.params as { id?: string };
    const format = route.action === "impact_run.exported" ? { format: (req.query as { format?: string }).format === "html" ? "html" : "json" } : {};
    await audit(ctx.db, { workspaceId: principal.workspaceId, actorType: "user", actorId: principal.userId, action: route.action, resourceType: route.resourceType, resourceId: String(params.id), at: ctx.clock.now(), metadata: format });
  });
}
