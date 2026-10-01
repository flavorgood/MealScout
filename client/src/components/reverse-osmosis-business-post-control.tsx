import { useEffect, useRef, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const pendingProfiles = new Set<string>();
type Props = { restaurantId: string; ready: boolean; onPrepared: (result: { restaurantId: string; draftId: string }) => void };

export default function ReverseOsmosisBusinessPostControl(props: Props) {
  return <BusinessPostEditor key={props.restaurantId} {...props} />;
}

function BusinessPostEditor({ restaurantId, ready, onPrepared }: Props) {
  const [postId, setPostId] = useState("");
  const [publish, setPublish] = useState(false);
  const [pending, setPending] = useState(pendingProfiles.has(restaurantId));
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A pending source request stays scoped across a profile switch and return.
  useEffect(() => {
    const listener = () => setPending(pendingProfiles.has(restaurantId));
    window.addEventListener("reverse-osmosis-pending", listener);
    return () => window.removeEventListener("reverse-osmosis-pending", listener);
  }, [restaurantId]);
  async function prepare() {
    if (!ready || pendingProfiles.has(restaurantId) || !postId.trim()) return;
    pendingProfiles.add(restaurantId);
    window.dispatchEvent(new Event("reverse-osmosis-pending"));
    setMessage("");
    try {
      const response = await apiRequest("POST", `/api/owner-ai/restaurants/${encodeURIComponent(restaurantId)}/reverse-osmosis/source-draft`, { postId: postId.trim(), publishPlatforms: publish ? ["facebook"] : [] });
      const result = await response.json();
      await queryClient.invalidateQueries({ queryKey: ["owner-ai-drafts", restaurantId] });
      if (!mounted.current) return;
      if (result.draft?.id) {
        setMessage("Draft prepared. Review the source evidence, changes and selected return post below before approving.");
        onPrepared({ restaurantId, draftId: result.draft.id });
      } else {
        setMessage("The post did not provide a supported current menu link. Review its public wording and source dates before preparing another draft.");
      }
    } catch {
      if (mounted.current) setMessage("The business post could not be verified. Check the selected Page connection, current owner access and public post link, then retry.");
    } finally {
      pendingProfiles.delete(restaurantId);
      window.dispatchEvent(new Event("reverse-osmosis-pending"));
    }
  }
  return <Card data-testid="owner-ai-reverse-osmosis-source">
    <CardHeader>
      <CardTitle>Reverse Osmosis from a business post</CardTitle>
      <CardDescription>Prepare your menu link from a public post on your connected Facebook business Page. MealScout checks the exact Page and post again when you approve.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <Label htmlFor="reverse-osmosis-post">Facebook business post link</Label>
      <Input id="reverse-osmosis-post" value={postId} onChange={event => setPostId(event.target.value)} placeholder="https://www.facebook.com/yourpage/posts/…" disabled={pending} />
      <p className="text-sm text-muted-foreground">The post must state a public menu URL, such as “Menu: https://yourbusiness.example/menu”. Prices, event dates and private appearances need their own verified evidence.</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={publish} onChange={event => setPublish(event.target.checked)} disabled={pending} />
        <span>Also prepare a return post for this same business Page. I will review its text and image with this exact draft.</span>
      </label>
      <Button type="button" onClick={prepare} disabled={!ready || pending || !postId.trim()}>{pending ? "Checking business post…" : "Prepare business-post draft"}</Button>
      <p className="text-sm text-muted-foreground">Preparing a draft leaves your profile unchanged. Publishing requires your approval of the selected return post.</p>
      {message ? <p role="status" className="text-sm">{message}</p> : null}
    </CardContent>
  </Card>;
}
