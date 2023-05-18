import React, { useState, useEffect, useRef } from "react";
import { Stage, Layer, Image } from "react-konva";
import useImage from "use-image";

import "./App.css";

const DraggableElement = ({ item, url, pos, onDragMove }) => {
  const [img] = useImage(url);

  const handleDragMove = (e) => {
    const newPos = e.target.position();
    onDragMove(newPos);
  };

  return (
    <Image
      width={100}
      height={100}
      image={img}
      draggable
      position={pos}
      onDragMove={handleDragMove}
    />
  );
};

const ReferenceElement = ({ url, pos, onClick }) => {
  const [img] = useImage(url);

  return (
    <Image
      width={100}
      height={100}
      image={img}
      position={pos}
      onClick={onClick}
    />
  );
};

function App() {
  const idCounter = useRef(2);
  const loading = useRef(false);
  const [elements, setElements] = useState([]);

  let updateElementPosition = (itemId, pos) => {
    setElements((elements) => {
      return elements.map((element) => {
        if (element.itemId === itemId) {
          return {
            ...element,
            pos: pos,
          };
        }
        return element;
      });
    });
  };

  useEffect(() => {
    if (loading.current) {
      return;
    }
    let stop = false;
    for (let elementA of elements) {
      for (let elementB of elements) {
        if (elementA !== elementB) {
          if (
            Math.abs(elementA.pos.x - elementB.pos.x) < 50 &&
            Math.abs(elementA.pos.y - elementB.pos.y) < 50
          ) {
            loading.current = true;
            stop = true;
            fetch(
              `/.netlify/functions/combine-elements?itemA=${elementA.result}&itemB=${elementB.result}`
            )
              .then((resp) => resp.json())
              .then((newElement) => {
                loading.current = false;
                setElements(
                  elements
                    .filter(
                      (element) =>
                        element.itemId !== elementA.itemId &&
                        element.itemId !== elementB.itemId
                    )
                    .concat([
                      Object.assign(newElement, {
                        itemId: idCounter.current++,
                        pos: { x: elementA.pos.x, y: elementA.pos.y },
                      }),
                    ])
                );
              });
          }
        }
        if (stop) {
          break;
        }
      }
      if (stop) {
        break;
      }
    }
  }, [elements]);

  return (
    <div className="App">
      <Stage width={window.innerWidth} height={window.innerHeight}>
        <Layer>
          <ReferenceElement
            url={"https://i.imgur.com/PtElSx4.jpeg"}
            pos={{ x: 0, y: 0 }}
            onClick={() => {
              setElements(
                elements.concat([
                  {
                    itemId: idCounter.current++,
                    item_a: "",
                    item_b: "",
                    result: "Stone",
                    result_img_url: "https://i.imgur.com/PtElSx4.jpeg",
                    pos: { x: 0, y: 10 },
                  },
                ])
              );
            }}
          />
          <ReferenceElement
            url={"https://i.imgur.com/3R5BxVh.jpeg"}
            pos={{ x: 100, y: 0 }}
            onClick={() => {
              setElements(
                elements.concat([
                  {
                    itemId: idCounter.current++,
                    item_a: "",
                    item_b: "",
                    result: "Fire",
                    result_img_url: "https://i.imgur.com/3R5BxVh.jpeg",
                    pos: { x: 100, y: 10 },
                  },
                ])
              );
            }}
          />
          {elements.map((element) => (
            <DraggableElement
              key={element.itemId}
              url={element.result_img_url}
              pos={element.pos}
              item={element.result}
              onDragMove={(pos) => updateElementPosition(element.itemId, pos)}
            />
          ))}
        </Layer>
      </Stage>
    </div>
  );
}

export default App;
