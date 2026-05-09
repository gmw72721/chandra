import { createIconResponse } from "@/lib/icon-response";

export const runtime = "nodejs";

export function GET() {
  return createIconResponse();
}
