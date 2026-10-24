import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import Welcome from "../../client/src/pages/welcome";
import { TRACKING_QUERY_KEYS } from "../../client/src/components/seo-head";
import { WELCOME_CONTENT } from "../../shared/welcomeContent";
import { renderAppDocumentHtml } from "./appDocumentHtml";

// Render the existing native Welcome, keeping its styles, background and links.
// The original template retains the normal App scripts and compiled asset base.
// No owner, session, business record or API/provider is read during this render.
export function renderHomepageHtml(
  template: string,
  canonicalBaseUrl: string,
  requestUrl = "/",
  forceNoIndex = false,
) {
  if (!/<div\s+id=["']root["']\s*>\s*<\/div>/.test(template)) {
    throw new Error("Native homepage template has no empty application root");
  }
  const url = new URL(requestUrl, "https://www.mealscout.us");
  const noIndex = forceNoIndex || Array.from(url.searchParams.keys()).some(key => TRACKING_QUERY_KEYS.has(key.toLowerCase()));
  const markup = renderToStaticMarkup(createElement(Router, { ssrPath: "/", children: createElement(Welcome) }));
  const canonical = new URL("/", canonicalBaseUrl).toString();
  return renderAppDocumentHtml(template, {
    markup, canonical, noIndex, title: WELCOME_CONTENT.title,
    description: WELCOME_CONTENT.description,
  });
}
