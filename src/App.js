import React from "react";
import ElementBox from "./components/ElementBox";
import InfoModal from "./components/InfoModal";
import { useDefaultPersistentGet } from "./lib/api";
import "./App.css";

function App() {
  const [starterElements, updateStarterElements, resetStarterElements] =
    useDefaultPersistentGet("elements", "/get-elements?starterElements=true");
  const size = Math.floor(
    Math.max(Math.min(window.innerHeight, window.innerWidth) * 0.2, 100)
  );
  return (
    <div style={{ height: "100%" }}>
      <InfoModal />
      {starterElements && (
        <ElementBox
          starterElements={starterElements}
          updateStarterElements={updateStarterElements}
          resetStarterElements={resetStarterElements}
          elementW={size}
          elementH={size}
        />
      )}
    </div>
  );
}

export default App;
