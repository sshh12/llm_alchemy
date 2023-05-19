import React, { useState, useEffect } from "react";
import Element from "./Element";
import { isTouchCapable } from "../lib/touch";

function boxesIntersect(a, b) {
  const halfWidthA = a.w / 2;
  const halfHeightA = a.h / 2;
  const halfWidthB = b.w / 2;
  const halfHeightB = b.h / 2;

  return (
    Math.abs(a.x - b.x) < halfWidthA + halfWidthB &&
    Math.abs(a.y - b.y) < halfHeightA + halfHeightB
  );
}

function findIntersections(elements, targetId) {
  const target = elements.find((el) => el.id === targetId);
  return elements
    .filter((el) => el.id !== targetId && boxesIntersect(el, target))
    .map((el) => el.id);
}

function ElementBox() {
  let [elements, setElements] = useState([
    { id: "0", x: 100, y: 100, w: 100, h: 100 },
    { id: "1", x: 300, y: 300, w: 100, h: 100 },
    { id: "2", x: 100, y: 600, w: 100, h: 100 },
  ]);
  let [dragId, setDragId] = useState(null);

  useEffect(() => {
    const onMove = ({ x, y }) => {
      setElements((state) => {
        if (dragId === null) return state;
        const dragElement = elements.find((el) => el.id === dragId);
        state = state
          .filter((element) => element.id !== dragId)
          .concat(Object.assign(dragElement, { x, y }));
        console.log(findIntersections(state, dragId));
        return state;
      });
    };

    const onTouch = (e) => {
      const touch = e.targetTouches[0];
      onMove({ x: touch.clientX, y: touch.clientY });
    };

    const onMouse = (e) => {
      onMove({ x: e.clientX, y: e.clientY });
    };

    if (isTouchCapable) {
      window.addEventListener("touchmove", onTouch);
    } else {
      window.addEventListener("mousemove", onMouse);
    }

    return () => {
      if (isTouchCapable) {
        window.removeEventListener("touchmove", onTouch);
      } else {
        window.removeEventListener("mousemove", onMouse);
      }
    };
  }, [dragId]);

  return (
    <div>
      {elements.map((element) => (
        <Element
          key={element.id}
          position={{ x: element.x, y: element.y }}
          size={{ w: element.w, h: element.h }}
          onDragStart={() => setDragId(element.id)}
          onDragStop={() => setDragId(null)}
        />
      ))}
    </div>
  );
}

export default ElementBox;
