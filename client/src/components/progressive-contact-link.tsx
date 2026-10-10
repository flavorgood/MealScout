import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { isProgressiveContactHref } from "@shared/progressiveAccountRoutes";
import { ProgressiveContactAnchor } from "./progressive-contact-anchor";

type ContactLinkProps = ComponentPropsWithoutRef<"a"> & { href: string };

const AccountContactLink = forwardRef<HTMLAnchorElement, ContactLinkProps>(
  function AccountContactLink(props, ref) {
    const { user } = useAuth();
    const [location] = useLocation();
    const destination = typeof window === "undefined" ? location : `${window.location.pathname}${window.location.search}${window.location.hash}`;
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
