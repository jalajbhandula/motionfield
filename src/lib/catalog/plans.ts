import type { PlanDef } from "./types";

/** Data-driven plans (feature flags drive UI). */
export const PLANS: PlanDef[] = [
  {
    id: "free", name: "Free", monthlyPrice: 0, annualMonthlyPrice: 0,
    creditsPerMonth: 0, tier: 0, parallelVideo: 1, parallelImage: 1,
    features: [
      "10 daily credits",
      "Watermarked results",
      "Standard queue",
      "Community access",
    ],
    freeGens: { "flux2-klein": 5 },
  },
  {
    id: "basic", name: "Basic", monthlyPrice: 10, annualMonthlyPrice: 9,
    creditsPerMonth: 150, tier: 1, parallelVideo: 2, parallelImage: 4,
    features: [
      "150 credits per month",
      "No watermark",
      "Character & character creation",
      "Priority queue",
      "Access to all image models",
      "Lip-sync studio",
    ],
  },
  {
    id: "pro", name: "Pro", monthlyPrice: 29, annualMonthlyPrice: 23,
    creditsPerMonth: 600, tier: 2, parallelVideo: 4, parallelImage: 4,
    features: [
      "600 credits per month",
      "Wan 2.1 Unlimited",
      "4 concurrent generations",
      "Character creation",
      "UGC ad pipelines",
      "Access to Pro video models",
      "Commercial rights",
    ],
    unlimitedModels: ["wan-2-1"],
  },
  {
    id: "max", name: "Max", monthlyPrice: 75, annualMonthlyPrice: 59,
    creditsPerMonth: 1800, tier: 3, parallelVideo: 4, parallelImage: 4,
    features: [
      "1800 credits per month",
      "Everything in Pro",
      "Unlimited LTX + Wan",
      "Top of queue",
      "Early access to new models",
      "Assistant",
    ],
    unlimitedModels: ["wan-2-1", "ltx-video"],
  },
  {
    id: "team", name: "Team", monthlyPrice: 65, annualMonthlyPrice: 55,
    creditsPerMonth: 3200, tier: 4, parallelVideo: 16, parallelImage: 16,
    seats: "2-9 seats · pooled credits",
    features: [
      "Shared credit pool",
      "16 parallel generations",
      "Members & roles",
      "Groups and spend controls",
      "Usage analytics",
    ],
    unlimitedModels: ["wan-2-1", "ltx-video"],
  },
  {
    id: "scale", name: "Scale", monthlyPrice: 130, annualMonthlyPrice: 110,
    creditsPerMonth: 12500, tier: 4, parallelVideo: 32, parallelImage: 32,
    seats: "5-15 seats · pooled credits",
    features: [
      "Everything in Team",
      "32 parallel generations",
      "SSO",
      "Sub-workspaces",
      "Dedicated support",
    ],
    unlimitedModels: ["wan-2-1", "ltx-video"],
  },
];

export const TOP_UP_PACKS = [
  { id: "pack-80", credits: 80, price: 5 },
  { id: "pack-170", credits: 170, price: 10 },
  { id: "pack-380", credits: 380, price: 20 },
  { id: "pack-840", credits: 840, price: 40 },
];

/** USD per credit at the SMALLEST top-up pack - the highest per-credit
 *  price we publish, so "≈$" figures never understate what the credits
 *  cost. Bigger packs get cheaper; the label says the rate it used. */
export const USD_PER_CREDIT = TOP_UP_PACKS[0].price / TOP_UP_PACKS[0].credits; // $0.0625

/** credits → "≈$X.XX" label text, honest about the rate it used */
export function creditsUsdLabel(credits: number): string {
  const usd = credits * USD_PER_CREDIT;
  return `≈$${usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)} at top-up rates`;
}

/** +4/+8/+12/+16 parallel-slot boost packs (90-day boost credits). */
export const BOOST_PACKS = [4, 8, 12, 16].map((slots, i) => ({
  id: `boost-${slots}`, slots, price: [10, 18, 24, 30][i], credits: [180, 320, 430, 540][i],
}));

export const DAILY_FREE_CREDITS = 10;

export function planById(id: string | null | undefined): PlanDef {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}
