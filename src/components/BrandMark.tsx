/** MotionField's mark - the AI Assistant's original lightning tile, restored
 *  as-is (outlined zap, stroke 2, on the accent tile at the same 13/24 scale)
 *  and used everywhere: header, favicon (src/app/icon.svg mirrors it), the
 *  assistant. The zap outline is the assistant's original Icon path. */
export const BRAND_ACCENT = "#d4ff3f";
export const BRAND_ZAP = "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";

export default function BrandMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role={title ? "img" : undefined}
      aria-label={title} aria-hidden={title ? undefined : true}>
      <rect width="32" height="32" rx="8" fill={BRAND_ACCENT} />
      <g transform="translate(7.33 7.33) scale(0.7222)">
        <path d={BRAND_ZAP} fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
