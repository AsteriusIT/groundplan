/**
 * The credential half of a repository's body — defined **once** (GP-229).
 *
 * The asymmetry this deletes: `credentialId` existed only on the update path,
 * so a repository covered by a GitHub App could not be attached, only repaired.
 * The update schema is now *derived* from this one rather than being a second
 * definition that looks the same today, so a fifth credential mode is added in
 * one place and both handlers grow it together.
 */

/** Shape shared by create and update. Every field optional in both. */
export const CREDENTIAL_PROPERTIES = {
  /**
   * A PAT, plaintext in, encrypted at rest, never echoed back. Kept even when a
   * connection is chosen, so switching back to it is one request (GP-192).
   */
  accessToken: { type: "string", minLength: 1, maxLength: 500 },
  /**
   * An org connection to authenticate through. `null` means "back to the PAT";
   * omitted means "leave it as it is".
   */
  credentialId: {
    type: ["string", "null"],
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  },
  /**
   * A GitHub App installation id — the form the discovery and connect flows
   * speak, so the caller never has to translate it into a connection id.
   */
  installationId: { type: "integer", minimum: 1 },
} as const;

/** The credential fields as a create-shaped fragment. */
export function credentialProperties(): Record<string, unknown> {
  return { ...CREDENTIAL_PROPERTIES };
}
