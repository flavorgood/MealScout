import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { MealScoutContext } from "./types";
import App from "./App";
import { apiUrl } from "@/lib/api";

const MealScoutContextReact = createContext<MealScoutContext | null>(null);

function MealScoutProvider({ context, children }: { context: MealScoutContext; children: ReactNode }) {
  return (
    <MealScoutContextReact.Provider value={context}>
      {children}
    </MealScoutContextReact.Provider>
  );
}

function MealScoutRoutes() {
  // For now, reuse the existing App component which already
  // wires up all internal routes such as /, /deals, etc.
  return <App />;
}

export function useMealScoutContext(): MealScoutContext {
  const value = useContext(MealScoutContextReact);
  if (!value) {
    throw new Error("useMealScoutContext must be used within a MealScoutProvider");
  }
  return value;
}

export function MealScoutApp({ context }: { context: MealScoutContext }) {
  return (
    <MealScoutProvider context={context}>
      <MealScoutRoutes />
    </MealScoutProvider>
  );
}

// Lightweight representation of the authenticated MealScout user
// returned from the TradeScout SSO endpoint.
export type MealScoutUser = {
  id: string;
  userType: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

export async function performMealScoutSSO(
  token: string,
  options?: { baseUrl?: string; timeoutMs?: number },
): Promise<MealScoutUser> {
  const baseUrl = options?.baseUrl?.replace(/\/$/, "") ?? "";
  const url = options?.baseUrl === undefined
    ? apiUrl("/api/auth/tradescout/sso")
    : `${baseUrl}/api/auth/tradescout/sso`;

  const controller = new AbortController();
  const timeout = options?.timeoutMs ?? 10000;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let errorBody: any = null;
      try {
        errorBody = await response.json();
      } catch {
        // ignore
      }
      const message = errorBody?.error || errorBody?.message || `SSO failed with status ${response.status}`;
      throw new Error(message);
    }

    const data = (await response.json()) as { user: MealScoutUser };
    return data.user;
  } finally {
    clearTimeout(timeoutId);
  }
}
