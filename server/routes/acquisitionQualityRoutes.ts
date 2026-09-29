import type { Express, RequestHandler } from "express";
import { parseAcquisitionHours } from "../../shared/acquisitionQuality";
import { readAcquisitionQuality, type AcquisitionQueryClient } from "../services/acquisitionQuality";

type Pool = { connect: () => Promise<AcquisitionQueryClient> };
export function acquireQualityClient(pool: Pool, timeout = 5000): Promise<AcquisitionQueryClient> {
  return new Promise((resolve,reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled=true; reject(new Error("Connection unavailable")); },timeout);
    Promise.resolve().then(() => pool.connect()).then(client => {
      if (settled) { client.release(); return; }
      settled=true;clearTimeout(timer);resolve(client);
    },() => { if(!settled) {settled=true;clearTimeout(timer);reject(new Error("Connection unavailable"));} });
  });
}
export function registerAcquisitionQualityRoutes(app: Express, authorize: RequestHandler, pool: Pool | undefined) {
  let active = 0;
  app.get("/api/admin/discovery-observatory/traffic-quality", authorize, async (req,res) => {
    res.setHeader("Cache-Control","private, no-store");res.setHeader("X-Robots-Tag","noindex, nofollow");
    let hours: 6 | 24 | 48;
    try {hours=parseAcquisitionHours(req.query.hours);} catch {return res.status(400).json({message:"Choose 6, 24, or 48 hours."});}
    if(!pool)return res.status(503).json({message:"Traffic evidence is unavailable. No totals were inferred."});
    if(active>=2)return res.status(429).set("Retry-After","5").json({message:"Report busy. Please retry."});
    active++;let client: AcquisitionQueryClient | undefined;
    try {client=await acquireQualityClient(pool);return res.json({report:await readAcquisitionQuality(client,hours,new Date(),{includeOriginRequests:true})});}
    catch {return res.status(503).json({message:"Traffic evidence is unavailable. No totals were inferred."});}
    finally {client?.release();active--;}
  });
}
