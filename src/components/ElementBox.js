import React, { useState, useEffect, useRef } from "react";
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

function ElementBox({ starterElements }) {
  const idCnt = useRef(3);
  const dragId = useRef(null);
  const [elements, setElements] = useState([
    {
      id: "0",
      x: 100,
      y: 100,
      w: 100,
      h: 100,
      hoverEffect: false,
      element: starterElements[0],
    },
    {
      id: "1",
      x: 300,
      y: 300,
      w: 100,
      h: 100,
      hoverEffect: false,
      element: starterElements[0],
    },
    {
      id: "2",
      x: 100,
      y: 600,
      w: 100,
      h: 100,
      hoverEffect: false,
      element: starterElements[0],
    },
  ]);

  useEffect(() => {
    const onMove = ({ x, y }) => {
      if (dragId.current === null) return;
      setElements((state) => {
        if (dragId.current === null) return state;
        const dragElement = state.find((el) => el.id === dragId.current);
        state = state
          .filter((element) => element.id !== dragId.current)
          .concat(Object.assign(dragElement, { x, y }));
        const intersections = findIntersections(state, dragId.current);
        state = state.map((element) => {
          if (intersections.includes(element.id)) {
            element.hoverEffect = true;
          } else {
            element.hoverEffect = false;
          }
          return element;
        });
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

  const onDragStart = (element) => {
    dragId.current = element.id;
  };

  const onDragStop = () => {
    if (dragId.current === null) return;
    const otherIds = findIntersections(elements, dragId.current).slice(0, 1);
    const stopDragId = dragId.current;
    dragId.current = null;
    setElements(
      ((state) => {
        const targetElement = state.find((e) => e.id === stopDragId);
        if (!targetElement) {
          return state;
        }
        console.log(otherIds);
        state = state.filter(
          (e) => e.id !== stopDragId && !otherIds.includes(e.id)
        );
        const newElement = Object.assign(targetElement, {
          id: (idCnt.current++).toString(),
        });
        state = state.concat([newElement]);
        console.log("new state", state);
        return state;
      })(elements)
    );
  };
  console.log(elements, dragId.current);

  return (
    <div>
      {elements.map((element) => (
        <Element
          key={element.id}
          position={{ x: element.x, y: element.y }}
          size={{ w: element.w, h: element.h }}
          onDragStart={() => onDragStart(element)}
          onDragStop={() => onDragStop()}
          hoverEffect={element.hoverEffect}
          element={element.element}
          name={element.id}
        />
      ))}
    </div>
  );
}

export default ElementBox;
