/**
 * Single source of truth for the app-shell navigation. Top-level entries are
 * the public surfaces; `children` render as the entry's dropdown.
 * `ready: false` entries are planned surfaces owned by upcoming workstreams -
 * they stay hidden until the workstream flips the flag.
 */
export type NavEntry = { label: string; href: string; ready: boolean; children?: NavEntry[] };

export const NAV_ENTRIES: NavEntry[] = [
  { label: "Image", href: "/ai/image", ready: true },
  { label: "Video", href: "/ai/video", ready: true },
  {
    label: "Audio", href: "/audio", ready: true, children: [
      { label: "Music & SFX", href: "/audio", ready: true },
      { label: "Voice Studio", href: "/audio?model=voice-studio", ready: true },
      { label: "Lip Sync", href: "/audio?model=lipsync", ready: true },
      { label: "Dub & Translate", href: "/dub-translate", ready: true },
    ],
  },
  {
    label: "Studio tools", href: "/apps", ready: true, children: [
      { label: "Edit Video", href: "/ai/video?model=wan-vace", ready: true },
      { label: "Remove Background", href: "/ai/image?model=birefnet", ready: true },
      { label: "Camera Control", href: "/generate", ready: true },
      { label: "Image Editor", href: "/image-editor", ready: true },
      { label: "Canvas", href: "/canvas", ready: true },
      { label: "Product Ads", href: "/product-ads", ready: true },
      { label: "Campaign Kit", href: "/campaigns", ready: true },
      { label: "Person Swap", href: "/person-swap", ready: true },
      { label: "Object Swap", href: "/object-swap", ready: true },
      { label: "Restyle Video", href: "/restyle", ready: true },
      { label: "Effects", href: "/effects", ready: true },
      { label: "Relight", href: "/relight", ready: true },
      { label: "Color Grade", href: "/color-grade", ready: true },
      { label: "3D Scene", href: "/scene-3d", ready: true },
      { label: "Game Builder", href: "/games", ready: true },
      { label: "Compare", href: "/compare", ready: true },
      { label: "Dub & Translate", href: "/dub-translate", ready: true },
      { label: "Character Creator", href: "/character-creator", ready: true },
    ],
  },
  { label: "AI Assistant", href: "/ai-assistant", ready: true },
  {
    label: "Developers", href: "/mcp", ready: true, children: [
      { label: "API reference", href: "/docs/api", ready: true },
    ],
  },
];
