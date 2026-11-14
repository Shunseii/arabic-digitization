import { type Href, useRouter } from "expo-router";

/**
 * Pops back to the previous screen (left slide, scroll position kept), falling
 * back to `fallback` only when there is no history, e.g. after a deep link.
 */
export const useGoBack = (fallback: Href) => {
  const router = useRouter();
  return () => (router.canGoBack() ? router.back() : router.replace(fallback));
};
