/** Test-only alias. Bindings are synthetic in-memory objects. */
export function getCloudflareContext() {
  return { env: (globalThis as unknown as { kithTestBindings: CloudflareEnv }).kithTestBindings };
}
