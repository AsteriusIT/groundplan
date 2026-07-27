/**
 * What to *do* about a refused attachment (GP-231).
 *
 * The backend already says what went wrong in a sentence; this adds the next
 * step, which is the part a generic "could not attach the repository" never
 * had. One table rather than a string per component: the same four codes come
 * back from the attach modal and from a bulk import, and a user who read
 * "install the app on its owner" once should read the same words the second
 * time.
 */
import type { AttachErrorCode } from "@/api/types";

export const ATTACH_REMEDIATION: Record<AttachErrorCode, string> = {
  no_credential_resolved:
    "Connect your code host for this organization, or paste an access token below.",
  installation_does_not_cover_repo:
    "Add this repository to the app's access on your code host, or attach it with a token.",
  insufficient_permissions:
    "The credential was refused. Check it grants read access to this repository.",
  unreachable:
    "Check the URL, and that this deployment can reach the host.",
};

/** The remediation for a code, or null when the server sent something else. */
export function attachRemediation(code: string | undefined): string | null {
  if (!code) return null;
  return ATTACH_REMEDIATION[code as AttachErrorCode] ?? null;
}
