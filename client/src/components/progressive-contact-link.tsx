import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { useLocationProperty } from "wouter/use-browser-location";
import { useAuth } from "@/hooks/useAuth";
import { isProgressiveContactHref } from "@shared/progressiveAccountRoutes";
import { ProgressiveContactAnchor } from "./progressive-contact-anchor";

type ContactLinkProps = ComponentPropsWithoutRef<"a"> & { href: string };

const currentInternalLocation = () => typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}${window.location.hash}`;
const serverInternalLocation = () => "/";

const AccountContactLink = forwardRef<HTMLAnchorElement, ContactLinkProps>(
  function AccountContactLink(props, ref) {
    const { user } = useAuth();
    // Wouter subscribes to popstate, pushState, replaceState and hashchange.
    // Snapshot the full URL so same-page query/hash updates refresh native hrefs.
    const destination = useLocationProperty(currentInternalLocation, serverInternalLocation);
    return <ProgressiveContactAnchor {...props} ref={ref} user={user} destination={destination} />;
  },
);

export const ProgressiveContactLink = forwardRef<HTMLAnchorElement, ContactLinkProps>(
  function ProgressiveContactLink(props, ref) {
    return isProgressiveContactHref(props.href)
      ? <AccountContactLink {...props} ref={ref} />
      : <a {...props} ref={ref} />;
  },
);
