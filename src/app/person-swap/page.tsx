import { Suspense } from "react";
import PersonSwapClient from "./person-swap-client";

export const metadata = { title: "Person Swap" };

export default function PersonSwapPage() {
  // useSearchParams (the ?clip=&gallery=&photo= deep link) needs a boundary
  return <Suspense><PersonSwapClient /></Suspense>;
}
