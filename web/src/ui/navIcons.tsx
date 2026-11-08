import type { ReactNode } from "react";

/**
 * Line icons for the sidebar, one per page. 24px grid, drawn in currentColor
 * with a 1.6 stroke so they sit with the text in either theme.
 */
export const NAV_ICONS = {
  overview: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
  conversations: <path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.3A8 8 0 1 1 20.5 11.5Z" />,
  console: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0M15.5 4.6a3.5 3.5 0 0 1 0 6.8M17.5 14.4A6 6 0 0 1 21 20" />
    </>
  ),
  memory: (
    <>
      <path d="M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2Z" />
      <path d="M5 20a2 2 0 0 0 2 1h12v-3M9 7.5h6M9 11h4" />
    </>
  ),
  identity: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="9" cy="10.5" r="2" />
      <path d="M5.8 16a3.3 3.3 0 0 1 6.4 0M14.5 10h3.5M14.5 13.5h3.5" />
    </>
  ),
  commands: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M14 8l-4 8" />
    </>
  ),
  spend: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.6 9.4c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.1 0-2.1-.5-2.6-1.4M12 6.3V8M12 16v1.7" />
    </>
  ),
  architecture: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.5 6h7M7.2 8.2l3.6 7.4M16.8 8.2l-3.6 7.4" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type NavIconName = keyof typeof NAV_ICONS;

export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {NAV_ICONS[name]}
    </svg>
  );
}
