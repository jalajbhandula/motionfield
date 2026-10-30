/**
 * Presentation metadata for the header menus - group, one-line description
 * and icon per href. Kept apart from nav.ts so workstreams flipping `ready`
 * flags there never collide with copy edits here. An href without an entry
 * still renders (in the "More" group, with a generic icon).
 */
export type NavIcon =
  | "camera" | "cube" | "spark" | "megaphone" | "layers" | "grid" | "scissors" | "cutout"
  | "wand" | "swap" | "reshoot" | "fire" | "sun" | "palette" | "users" | "user-plus"
  | "mic" | "gamepad" | "compare" | "motion" | "compass" | "tag" | "plug" | "code" | "dot";

export type NavMeta = { group: string; desc: string; icon: NavIcon };

/** Mega-menu column order; unknown groups fall in after these. */
export const NAV_GROUP_ORDER = ["Create", "Edit", "Transform", "Characters & voice", "More"];

export const NAV_META: Record<string, NavMeta> = {
  // Studio tools
  "/generate": { group: "Create", desc: "Cinematic shots with real camera moves", icon: "camera" },
  "/scene-3d": { group: "Create", desc: "Block a scene in 3D, orbit it, render a real shot", icon: "cube" },
  "/motion-graphics": { group: "Create", desc: "Animated titles and graphics", icon: "motion" },
  "/product-ads": { group: "Create", desc: "Product ads from a single photo", icon: "megaphone" },
  "/campaigns": { group: "Create", desc: "Every campaign format in one run", icon: "spark" },
  "/games": { group: "Create", desc: "Describe a game, play it in the browser", icon: "gamepad" },
  "/image-editor": { group: "Edit", desc: "AI image edits - describe the change", icon: "layers" },
  "/canvas": { group: "Edit", desc: "An open board for ideas and references", icon: "grid" },
  "/re-edit-video": { group: "Edit", desc: "Remake an edit shot by shot with your cast", icon: "scissors" },
  "/ai/image?model=birefnet": { group: "Edit", desc: "Remove any background in one click", icon: "cutout" },
  "/ai/video?model=wan-vace": { group: "Edit", desc: "Steer video with depth, pose or masks", icon: "wand" },
  "/compare": { group: "Edit", desc: "One prompt, several models, side by side", icon: "compare" },
  "/person-swap": { group: "Transform", desc: "Swap a person or a scene in any video", icon: "swap" },
  "/new-camera-move": { group: "Transform", desc: "Change the camera on footage you shot", icon: "reshoot" },
  "/visual-effects": { group: "Transform", desc: "Visual effects on your clips and stills", icon: "fire" },
  "/effects": { group: "Transform", desc: "One-tap effects for photos and clips", icon: "spark" },
  "/relight": { group: "Transform", desc: "Move and recolour the light in a photo", icon: "sun" },
  "/object-swap": { group: "Transform", desc: "Replace an object in a clip, keep the motion", icon: "cube" },
  "/restyle": { group: "Transform", desc: "Re-render a clip in a new visual style", icon: "wand" },
  "/color-grade": { group: "Transform", desc: "Grade colour from a look or a reference", icon: "palette" },
  "/character-studio": { group: "Characters & voice", desc: "Keep a character consistent across shots", icon: "users" },
  "/character-creator": { group: "Characters & voice", desc: "Create a new character step by step", icon: "user-plus" },
  "/dub-translate": { group: "Characters & voice", desc: "Translate speech in the same voice, lips synced", icon: "mic" },
  // API/MCP
  "/docs/api": { group: "API", desc: "REST and MCP for scripts and agents", icon: "code" },
};

export const navMeta = (href: string): NavMeta =>
  NAV_META[href] ?? { group: "More", desc: "", icon: "dot" };
