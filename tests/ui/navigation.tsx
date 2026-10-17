import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const navigate = (href: string, replace = false) => {
  window.history[replace ? "replaceState" : "pushState"]({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
};
const router = {
  replace: (href: string) => navigate(href, true),
  push: (href: string) => navigate(href),
};
export const useRouter = () => router;
export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search));
export const usePathname = () => useSyncExternalStore(subscribe, () => window.location.pathname);
