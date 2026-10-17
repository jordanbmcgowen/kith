// Fixture-only entry point. This is bundled by the regression runner, never by Next.
import { createRoot } from "react-dom/client";
import { FindScreen } from "../../src/components/FindScreen";
import { PeopleScreen } from "../../src/components/PeopleScreen";
import { ConfirmScreen } from "../../src/components/ConfirmScreen";
import { CaptureScreen } from "../../src/components/CaptureScreen";
import { usePathname } from "./navigation";

function Fixture() {
  const path = usePathname();
  return <main className="app"><div className="view">
    {path === "/find" ? <FindScreen /> : path === "/people" ? <PeopleScreen />
      : path.startsWith("/notes/") ? <ConfirmScreen id={path.split("/").at(-1)!} />
      : path === "/record" ? <CaptureScreen /> : <p>Fixture destination</p>}
  </div></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

if (window.location.pathname === "/__checks") {
  import("./browser-check").then(({ runBrowserChecks }) => { void runBrowserChecks(); });
}
