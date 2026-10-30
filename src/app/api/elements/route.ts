/**
 * /api/elements is kept as an internal alias of the refs surface - same
 * handlers, same table. Nothing should link here; use /api/refs.
 */
export { GET, POST } from "../refs/route";
export const runtime = "nodejs";
