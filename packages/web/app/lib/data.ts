import { apiGet } from "./api";
import type { ProjectOverview } from "./types";

export const getOverview = (orgId: string, projectId: string) =>
  apiGet<ProjectOverview>(`/orgs/${orgId}/projects/${projectId}/overview`);

export function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24);
  if (dd < 30) return `${dd}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const humanizeAction = (a: string): string =>
  a.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
