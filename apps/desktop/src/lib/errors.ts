import { ApiError } from "./api";

/** A sentence for an error state's body: what went wrong and what to do. */
export const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403)
      return `The API rejected your key (${error.status}). Check it in Settings.`;
    if (error.status === 404) return "The API couldn't find it (404).";
    return `The API returned an error (${error.status}). Try again in a moment.`;
  }
  if (error instanceof TypeError)
    return "The API didn't respond. Check your connection, then try again.";
  return error instanceof Error ? error.message : String(error);
};
