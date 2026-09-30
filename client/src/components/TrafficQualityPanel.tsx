import { useEffect,useRef,useState } from "react";
import { parseAcquisitionQualityReport,type AcquisitionQualityReport } from "@shared/acquisitionQuality";
const readable=(value:string)=>value.replace(/_/g," ");
const format=(value:number|null)=>value===null?"Unavailable":value.toLocaleString();
export default function TrafficQualityPanel() {
  const [hours,setHours]=useState("24");
  const [report,setReport]=useState<AcquisitionQualityReport|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  const operation=useRef<{sequence:number;controller:AbortController|null}>({sequence:0,controller:null});
  async function load(selected=hours) {
    operation.current.controller?.abort();const seq=++operation.current.sequence;
    const controller=new AbortController();operation.current.controller=controller;
    setLoading(true);setError(null);setReport(null);const timer=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch("/api/admin/discovery-observatory/traffic-quality?"+new URLSearchParams({hours:selected}),{credentials:"include",cache:"no-store",signal:controller.signal});
      if(!response.ok)throw new Error(response.status===401||response.status===403?"Administrator access is required. Sign in again.":"Traffic evidence is unavailable.");
      const body=await response.json();const parsed=parseAcquisitionQualityReport(body?.report);
      if(parsed.hours!==Number(selected))throw new Error("Window mismatch");
      if(seq===operation.current.sequence)setReport(parsed);
    } catch(cause) {if(seq===operation.current.sequence)setError(controller.signal.aborted?"Report timed out. Retry the report.":cause instanceof Error&&cause.message.startsWith("Administrator")?cause.message:"Traffic evidence is unavailable. No missing values were treated as zero.");}
    finally {clearTimeout(timer);if(seq===operation.current.sequence){setLoading(false);operation.current.controller=null;}}
  }
  useEffect(()=>{void load("24");return()=>{operation.current.sequence++;operation.current.controller?.abort();};},[]);
  return <main className="space-y-6 py-8" data-testid="traffic-quality-panel">
    <header><h1 className="text-3xl font-bold">MealScout traffic quality</h1><p className="mt-3 max-w-4xl text-sm leading-6 text-muted-foreground">Separate uptime monitoring, crawler signals, browser-shaped requests, and recorded discovery journeys. Browser candidates are not verified people; source labels do not establish organic referrals.</p></header>
    <div role="note" className="rounded-md border p-4 text-sm leading-6"><strong>Retention limit: 48 hours.</strong> General profile and request records expire after 48 hours. This view uses available retained records, not a complete long-term traffic baseline. Sanitized observatory history has separate retention. No history is backfilled and no retention policy is changed.</div>
    <div className="flex flex-wrap items-end gap-3"><label className="grid gap-2 text-sm">Rolling window<select value={hours} onChange={e=>setHours(e.target.value)} className="min-h-11 rounded-md border bg-background px-3">{[6,24,48].map(h=><option key={h} value={h}>Last {h} hours</option>)}</select></label><button disabled={loading} onClick={()=>void load()} className="min-h-11 rounded-md border px-4 disabled:opacity-50">Apply window</button><button disabled={loading} onClick={()=>void load()} className="min-h-11 rounded-md border px-4 disabled:opacity-50">Refresh</button></div>
    {loading?<p role="status">Loading retained traffic evidence…</p>:error?<div role="alert" className="rounded-md border p-4"><p>{error}</p><button onClick={()=>void load()} className="mt-3 min-h-11 rounded-md border px-4">Retry report</button></div>:report?<div data-testid="traffic-quality-results" className="space-y-7">
      <p className="break-words text-sm text-muted-foreground">Available retained records from {report.from} to {report.toExclusive} (exclusive), UTC. Applied window: {report.hours} hours.</p>
      <section aria-label="Origin request traffic" className="space-y-3">
        <h2 className="text-xl font-semibold">Requests recorded at Render</h2>
        <p className="text-sm leading-6 text-muted-foreground">These are retained backend HTTP requests, not people, sessions, or complete page views. Vercel can serve pages without reaching Render. Crawler identities are user-agent claims, not independently verified providers. Monitoring stays enabled and never becomes customer acquisition.</p>
        {report.originRequests ? <><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[
          ["Infrastructure monitoring",report.originRequests.infrastructureMonitorRequests,"Health checks and UptimeRobot-style signals."],
          ["Search / AI crawler signals",report.originRequests.discoveryCrawlerRequests,"Claimed crawler or user-triggered assistant requests; not customer visits."],
          ["Other automation",report.originRequests.automationRequests,"Headless browsers, scripts, QA user agents and generic bots."],
          ["Browser-shaped requests",report.originRequests.browserShapedRequests,"A browser-like user agent alone does not prove a person."],
          ["Unclassified requests",report.originRequests.unclassifiedRequests,"Missing or unsupported evidence stays unknown."]
        ].map(([title,value,note])=><article key={String(title)} className="min-w-0 rounded-lg border p-4"><h3 className="text-sm font-medium">{title}</h3><p className="my-3 text-2xl font-bold">{Number(value).toLocaleString()}</p><p className="text-xs leading-5 text-muted-foreground">{note}</p></article>)}</div><p className="text-sm">{report.originRequests.totalRequests.toLocaleString()} recorded origin requests; {report.originRequests.errorRequests.toLocaleString()} returned HTTP 400 or higher. These totals are separate from the discovery events below.</p></> : <p className="text-sm">Origin request evidence is unavailable. No request counts were inferred.</p>}
      </section>
      {report.classifiedAcquisitionEvents===0?<p className="rounded-md border p-4 text-sm">No classified acquisition events are available in this window. Missing evidence and historical-only records do not imply zero people.</p>:null}
      <section aria-label="Acquisition summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
        ["Recorded entry events",format(report.entryEvents),"Recorded landings, not search impressions. Includes unclassified records."],
        ["Browser-candidate journeys",format(report.candidateJourneys),"Requires a journey identity; diagnostic, crawler, monitor or automation evidence anywhere in retained discovery history excludes that journey."],
        ["Candidate journeys with action",format(report.candidateJourneysWithAction),"A later recorded action, not an order, customer, or verified outcome."],
        ["Profile-quality reports excluded",format(report.profileQualityReports),"Missing menus, schedules, images and page errors never count as entries or actions."]
      ].map(([title,value,note])=><article key={title} className="min-w-0 rounded-lg border p-4"><h2 className="text-sm font-medium">{title}</h2><p className="my-3 break-words text-2xl font-bold">{value}</p><p className="text-xs leading-5 text-muted-foreground">{note}</p></article>)}</section>
      <section><h2 className="text-xl font-semibold">Quality breakdown</h2><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{report.quality.map(row=><article key={row.classification} className="rounded-lg border p-4"><h3 className="font-medium capitalize">{readable(row.classification)}</h3><p className="mt-2 text-sm">{row.entryEvents} entries · {row.actionEvents} actions</p><p className="text-sm text-muted-foreground">{row.qualityReports} profile-quality reports · {row.otherRecords} other records</p></article>)}</div>{!report.quality.length?<p className="mt-3 text-sm">No matching retained records were returned.</p>:null}</section>
      <section><h2 className="text-xl font-semibold">Source-labeled candidate journeys</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{report.sources.map(row=><article key={row.source} className="rounded-lg border p-4"><h3 className="capitalize">{readable(row.source)}</h3><p className="mt-2 text-sm">{row.journeys} candidate journeys · {row.journeysWithAction} with a recorded action</p></article>)}</div>{!report.sources.length?<p className="mt-3 text-sm">No candidate source groups are available.</p>:null}</section>
      <section className="rounded-lg border p-4 text-sm leading-6"><h2 className="font-semibold">Unavailable metrics</h2><p>Verified people, Google impressions and clicks, and verified customer outcomes are unavailable in this report. Profile errors and clicks never establish completed orders or merchant receipt.</p><p>Totals cover retained evidence only: {report.recordedRows} matching rows, including {report.otherRecords} records outside entry/action/profile-quality stages. No full-period or cross-device attribution is inferred.</p></section>
    </div>:null}
  </main>;
}
