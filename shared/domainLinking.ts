import { z } from "zod";

const dnsHostname = z.string().trim().toLowerCase().max(255)
  .transform(value => value.replace(/\.$/, ""))
  .pipe(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/));
const hostname = dnsHostname.transform(value => value.replace(/^www\./, ""));

const verificationSchema = z.object({
  hostname,
  restaurantId: z.string().uuid(),
  canonicalPath: z.string().max(500),
  status: z.enum(["unverified", "verified", "mismatch", "error"]),
  expectedTarget: dnsHostname,
  lastCheckedAt: z.string().datetime().optional(),
  diagnostics: z.string().max(2_000).optional(),
});

export type DomainVerification = z.infer<typeof verificationSchema>;

export function readSavedBusinessDomain(value: unknown, restaurantId: string): DomainVerification | null {
  const parsed = verificationSchema.safeParse(value);
  if (!parsed.success || parsed.data.restaurantId !== restaurantId || parsed.data.canonicalPath !== "/restaurant/" + encodeURIComponent(restaurantId)) return null;
  return parsed.data;
}

export async function verifySelfManagedDomain(
  restaurantId: string,
  rawHostname: string,
  request: (path: string, body: { hostname: string; restaurantId: string }) => Promise<unknown>,
): Promise<DomainVerification> {
  const body = z.object({ hostname, restaurantId: z.string().uuid() }).strict().parse({ hostname: rawHostname, restaurantId });
  const result = readSavedBusinessDomain(await request("/api/settings/custom-domain/verify", body), restaurantId);
  if (!result || result.hostname !== body.hostname) throw new Error("DOMAIN_VERIFICATION_BINDING_MISMATCH");
  return result;
}
