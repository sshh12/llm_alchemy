import React from "react";
import ElementBox from "./components/ElementBox";
import { useGet } from "./lib/api";
import "./App.css";

function App() {
  const [elements] = useGet("/get-elements");
  return (
    <div style={{ height: "100%" }}>
      {elements && (
        <ElementBox starterElements={elements} elementW={100} elementH={100} />
      )}
    </div>
  );
}

export default App;
