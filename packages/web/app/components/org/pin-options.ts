import { getCatalog } from "@/lib/org-data";
import type { PinOption } from "./ItemEditor";

/** Published skills and checks a standard can pin, by exact version. */
export async function pinOptions(orgId: string): Promise<{ skills: PinOption[]; checks: PinOption[] }> {
  const [s, c] = await Promise.all([getCatalog(orgId, "skill"), getCatalog(orgId, "check")]);
  const opt = (rows: NonNullable<typeof s>["items"]) =>
    rows
      .filter((r) => r.published)
      .map((r) => ({ itemId: r.id, versionId: r.published!.id, label: `${r.name} · v${r.published!.version}` }));
  return { skills: opt(s?.items ?? []), checks: opt(c?.items ?? []) };
}

/** Published requirements a check can link to. */
export async function requirementOptions(orgId: string) {
  const { apiGet } = await import("@/lib/api");
  const r = await apiGet<{ requirements: Array<{ key: string; text: string; standard: string }> }>(`/orgs/${orgId}/catalog/requirements`);
  return r?.requirements ?? [];
}
