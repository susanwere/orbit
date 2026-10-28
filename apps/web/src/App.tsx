import { useState } from "react";
import { Landing } from "./Landing.js";
import { Universe } from "./Universe.js";

export function App() {
  const [entered, setEntered] = useState(false);
  return entered
    ? <Universe onExit={() => setEntered(false)} />
    : <Landing onEnter={() => setEntered(true)} />;
}
