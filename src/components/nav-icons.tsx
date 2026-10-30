import type { NavIcon } from "@/lib/nav-meta";

/** 20px stroke icons for the header menus (drawn for MotionField). */
const PATHS: Record<NavIcon, string> = {
  camera: "M4 7h3l2-2h6l2 2h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18",
  megaphone: "M4 10v4h3l7 4V6L7 10zM17 9a4 4 0 0 1 0 6",
  layers: "M12 4l9 5-9 5-9-5zM3 14l9 5 9-5",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  scissors: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.5 7.5L20 18M8.5 16.5L20 6",
  cutout: "M5 5h4M15 5h4v4M19 15v4h-4M9 19H5v-4M5 9v2M19 11v2M11 5h2M11 19h2M9 15l3-6 3 6z",
  wand: "M4 20L15 9M14 4v2M19 9h2M17.5 5.5L16 7M18 13l-1.5-1.5M10 5l1.5 1.5",
  swap: "M7 7h11l-3-3M17 17H6l3 3M5 11a3 3 0 1 0 0-.01M19 13a3 3 0 1 0 0 .01",
  reshoot: "M3 8h4l2-3h6l2 3h4v11H3zM9 13a3 3 0 0 0 5.5 1.5M15 12a3 3 0 0 0-5.5-1.5",
  fire: "M12 21c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8 0 4 3 7 7 7z",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19",
  palette: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-2 0-3 2 0 3 0a4 4 0 0 0 4-4c0-5-4-9-9-9zM7.5 11h.01M10 7h.01M15 7.5h.01",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7M19 14a6 6 0 0 1 3 7",
  "user-plus": "M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 21a7 7 0 0 1 12-5M19 14v6M16 17h6",
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM6 11a6 6 0 0 0 12 0M12 17v4",
  gamepad: "M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.5 1.7L14 13h-4l-1.5 1.7A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4zM8 10v3M6.5 11.5h3M15.5 11h.01M17 12.5h.01",
  compare: "M4 5h7v14H4zM13 5h7v14h-7zM7.5 9v6M16.5 9v6",
  motion: "M3 12h4l3-7 4 14 3-7h4",
  compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14",
  dot: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
};

export function NavGlyph({ name, className = "h-5 w-5" }: { name: NavIcon; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Chevron({ open = false, className = "h-3.5 w-3.5" }: { open?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`${className} transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
