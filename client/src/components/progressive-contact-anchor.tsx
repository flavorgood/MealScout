import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { getProgressiveContactGatePath } from "@shared/progressiveAccountRoutes";

export type ProgressiveContactAnchorProps = ComponentPropsWithoutRef<"a"> & {
  href: string;
  user: { emailVerified?: unknown } | null | undefined;
  destination: string;
};

// Set the actual href so keyboard, middle-click and new-tab navigation use the
// same boundary. Authentication returns to the page for a fresh explicit click.
export const ProgressiveContactAnchor = forwardRef<HTMLAnchorElement, ProgressiveContactAnchorProps>(
  function ProgressiveContactAnchor({ user, destination, href, ...props }, ref) {
    const gateHref = getProgressiveContactGatePath(user, href, destination);
    return <a {...props} ref={ref} href={gateHref || href} />;
  },
);
