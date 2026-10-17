/** Test-only alias. Never imported by application entrypoints. */
export async function requireUser() {
  const id = (globalThis as unknown as { kithTestUser?: string }).kithTestUser;
  if (!id) throw Object.assign(new Error("Synthetic signed out"), { status: 401 });
  return id;
}
