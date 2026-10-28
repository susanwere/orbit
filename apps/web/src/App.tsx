import { useState } from "react";
import { Landing } from "./Landing.js";

export function App() {
  const [entered, setEntered] = useState(false);

  if (!entered) {
    return <Landing onEnter={() => setEntered(true)} />;
  }

  return (
    <main className="baseline">
      <p className="eyebrow">Orbit</p>
      <h1>Clean implementation baseline.</h1>
      <p>
        The legacy demo runtime has been removed. Product flows will be rebuilt
        against the approved backend and frontend designs.
      </p>
      <button className="cta-primary" onClick={() => setEntered(false)}>
        Back to Orbit
      </button>
    </main>
  );
}
