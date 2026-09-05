import { auth, signIn, signOut } from "@/lib/auth";

const button = {
  font: "inherit",
  padding: "12px 20px",
  border: "1px solid #294740",
  borderRadius: 0,
  background: "transparent",
  color: "#F1EADC",
  cursor: "pointer",
};

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main style={{ textAlign: "center" }}>
        <h1 style={{ fontWeight: 400, margin: "0 0 8px" }}>Kith</h1>
        <p style={{ color: "#8CA69B", margin: "0 0 32px" }}>
          A private memory system for the people in your life.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button type="submit" style={button}>
            Sign in with Google
          </button>
        </form>
      </main>
    );
  }

  return (
    <main style={{ textAlign: "center" }}>
      <h1 style={{ fontWeight: 400, margin: "0 0 8px" }}>Signed in</h1>
      <p style={{ color: "#8CA69B", margin: "0 0 4px" }}>{session.user.name}</p>
      <p style={{ color: "#587068", margin: "0 0 8px" }}>{session.user.email}</p>
      <p
        style={{
          color: "#587068",
          font: "13px/1.5 ui-monospace, monospace",
          margin: "0 0 32px",
        }}
      >
        {session.user.id}
      </p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button type="submit" style={button}>
          Sign out
        </button>
      </form>
    </main>
  );
}
