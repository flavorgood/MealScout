type Props = { envelope: unknown };
export default function ReverseOsmosisDraftEvidence({ envelope }: Props) {
  if (!envelope || typeof envelope !== "object") return null;
  const ro = envelope as Record<string, any>;
  const capture = ro.capture;
  if (!capture || typeof capture.capturedAt !== "number" || !Number.isFinite(capture.capturedAt)) return null;
  let url: URL;
  try { url = new URL(String(capture.sourceUrl)); } catch { return null; }
  if (url.protocol !== "https:" || !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(url.hostname) || url.username || url.password) return null;
  return <section className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm" aria-labelledby="reverse-osmosis-evidence-heading">
    <h2 id="reverse-osmosis-evidence-heading" className="font-bold">Business-post source evidence</h2>
    <p className="mt-2">Captured {new Date(capture.capturedAt).toLocaleString()} from <a href={url.href} target="_blank" rel="noopener noreferrer" className="underline">this Facebook business post</a>.</p>
    <p className="mt-2">This revision applies the captured menu link. {Array.isArray(ro.outbound) && ro.outbound.length ? "It also includes the selected return post for the same business Page; review its text and image below." : "No return post was selected."}</p>
    <p className="mt-2 text-xs">The exact source, Page binding and full native version are checked again before an effect. Changed or uncertain operations remain held.</p>
  </section>;
}
