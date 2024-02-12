import React from "react";
import ElementBox from "./components/ElementBox";
import InfoModal from "./components/InfoModal";
import {
  useDefaultPersistentGet,
  usePollingGet,
  useLocalStorage,
  getDate,
} from "./lib/api";
import { v4 as uuidv4 } from "uuid";
import { ChakraProvider } from "@chakra-ui/react";
import "./App.css";

function App() {
  const [starterElements, updateStarterElements, resetStarterElements] =
    useDefaultPersistentGet("elements", "/get-elements?starterElements=true");
  const [userId] = useLocalStorage(
    "alchemy:userId",
    () => "alchemy:" + uuidv4()
  );
  const date = getDate();
  const [stats, pollStats] = usePollingGet(
    `/get-stats?userId=${userId}&date=${date}`
  );
  const size = Math.floor(
    Math.max(Math.min(window.innerHeight, window.innerWidth) * 0.2, 100)
  );
  return (
    <ChakraProvider>
      <div style={{ height: "100%" }}>
        <InfoModal />
        {starterElements && (
          <ElementBox
            starterElements={starterElements}
            updateStarterElements={updateStarterElements}
            resetStarterElements={resetStarterElements}
            stats={stats}
            pollStats={pollStats}
            elementW={size}
            elementH={size}
            userId={userId}
          />
        )}
      </div>
    </ChakraProvider>
  );
}

export default App;
