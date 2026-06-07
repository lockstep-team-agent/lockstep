import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

export const IconOverview = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
);
export const IconDecisions = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>
);
export const IconQuestions = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M9.2 9.2a2.8 2.8 0 0 1 5.3 1c0 1.8-2.7 2.2-2.7 4" /><circle cx="12" cy="17.3" r="0.6" fill="currentColor" /></svg>
);
export const IconTasks = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M8 12l2.5 2.5L16 9" /></svg>
);
export const IconContracts = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9.5 13l-1.5 1.5L9.5 16" /><path d="M14.5 13l1.5 1.5-1.5 1.5" /></svg>
);
export const IconDependencies = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M7.6 8l3 7.5M16.4 8l-3 7.5M8.5 6h7" /></svg>
);
export const IconActivity = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 12h4l2.5 7 5-15L17 12h4" /></svg>
);
export const IconMembers = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 5.5a3 3 0 0 1 0 5.8M21 19a5 5 0 0 0-4-4.9" /></svg>
);
export const IconLogout = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" /><path d="M16 17l5-5-5-5M21 12H9" /></svg>
);
export const IconArrow = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconInbox = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 13l3-8h12l3 8M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5M3 13h5l1.5 2.5h5L16 13h5" /></svg>
);
export const IconRepo = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 3h11a2 2 0 0 1 2 2v15l-4-2-4 2-4-2V5a2 2 0 0 1 2-2z" /><path d="M9 7h6" /></svg>
);
