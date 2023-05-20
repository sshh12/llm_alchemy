import React from "react";
import ElementBox from "./components/ElementBox";
import { useGet } from "./lib/api";
import "./App.css";

function App() {
  const [elements] = useGet("/get-elements");
  const size = Math.floor(
    Math.max(Math.min(window.innerHeight, window.innerWidth) * 0.2, 100)
  );
  return (
    <div style={{ height: "100%" }}>
      {elements && (
        <ElementBox
          starterElements={elements}
          elementW={size}
          elementH={size}
        />
      )}
    </div>
  );
}

export default App;
