import React from "react";
import ElementBox from "./components/ElementBox";
import { useGet } from "./lib/api";
import "./App.css";

function App() {
  const [elements] = useGet("/get-elements?starterElements=true");
  return <div>{elements && <ElementBox starterElements={elements} />}</div>;
}

export default App;
