export const mapPublicSeoLandingPathToEndpoint = (pathname: string) => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "food-trucks" && parts[1] && parts[2]) {
    return `/api/public/seo/food-trucks/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}`;
  }
  if (parts[0] === "food-trucks" && parts[1]) {
    return `/api/public/seo/food-trucks/${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "food-trucks-today" && parts[1]) {
    return `/api/public/seo/food-trucks-today/${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "food-truck-catering" && parts[1]) {
    return `/api/public/seo/food-truck-catering/${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "book-food-truck" && parts[1]) {
    return `/api/public/seo/book-food-truck/${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "deals-today" && parts[1]) {
    return `/api/public/seo/deals-today/${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "events-today" && parts[1]) {
    return `/api/public/seo/events-today/${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "city" && parts[1] && parts[2] === "food") {
    return `/api/public/seo/city/${encodeURIComponent(parts[1])}/food`;
  }
  if (parts[0] === "cuisine" && parts[1] && parts[2]) {
    return `/api/public/seo/cuisine/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}`;
  }
  if (parts[0] === "cuisine" && parts[1]) {
    return `/api/public/seo/cuisine/${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "locations-with-trucks" && parts[1]) {
    return `/api/public/seo/locations-with-trucks/${encodeURIComponent(parts[1])}`;
  }
  return null;
};

export const mapPublicSeoLandingSourcePageType = (
  routeKey: string | null | undefined,
) => {
  switch (String(routeKey || "")) {
    case "food-trucks":
    case "food-trucks-cuisine":
      return "food_trucks_city";
    case "food-trucks-today":
      return "food_trucks_today";
    case "food-truck-catering":
      return "food_truck_catering";
    case "book-food-truck":
      return "book_food_truck";
    case "deals-today":
      return "deals_today";
    case "events-today":
      return "events_today";
    case "city":
      return "city_food";
    case "cuisine":
      return "cuisine";
    case "locations-with-trucks":
      return "locations_with_trucks";
    default:
      return "city_food";
  }
};
