import React, { useState, useEffect, useRef } from "react";
import Element from "./Element";
import { isTouchCapable } from "../lib/touch";
import { useGetFetch } from "../lib/api";

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

function ElementBox({
  starterElements,
  updateStarterElements,
  elementW,
  elementH,
}) {
  const idCnt = useRef(0);
  const dragId = useRef(null);
  const [elements, setElements] = useState([]);

  const [fetchAPI] = useGetFetch();

  useEffect(() => {
    starterElements.forEach((v) => {
      if (!v.imgUrl) {
        fetchAPI(`/get-element?id=${v.id}`).then((updatedValue) => {
          if (updatedValue.imgUrl) {
            updateStarterElements((state) => {
              state = state.filter((e) => e.id !== updatedValue.id);
              state = state.concat([updatedValue]);
              state = state.sort((a, b) => a.name.localeCompare(b.name));
              return state;
            });
          }
        });
      }
    });
  }, []);

  useEffect(() => {
    const onMove = ({ x, y }) => {
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
      if (dragId.current === null) return;
      e.preventDefault();
      const touch = e.targetTouches[0];
      onMove({ x: touch.pageX, y: touch.pageY });
    };

    const onMouse = (e) => {
      if (dragId.current === null) return;
      e.preventDefault();
      onMove({ x: e.pageX, y: e.pageY });
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

  const onDragStart = (element, e) => {
    e.preventDefault();
    document.getElementsByTagName("html")[0].style.overflow = "hidden";
    dragId.current = element.id;
  };

  const onDragStop = (e) => {
    if (dragId.current === null) return;
    e.preventDefault();
    document.getElementsByTagName("html")[0].style.overflow = null;
    const otherIds = findIntersections(elements, dragId.current).slice(0, 1);
    const stopDragId = dragId.current;
    dragId.current = null;
    if (otherIds.length === 0) return;
    setElements(
      ((state) => {
        const targetElement = state.find((e) => e.id === stopDragId);
        if (!targetElement) {
          return state;
        }
        state = state.filter(
          (e) => e.id !== stopDragId && !otherIds.includes(e.id)
        );
        const otherElements = otherIds.map((id) =>
          elements.find((e) => e.id === id)
        );
        const newElement = Object.assign({}, targetElement, {
          id: (idCnt.current++).toString(),
          element: null,
          imgUrl: null,
          name: "...",
        });
        fetchAPI(
          `/combine-elements?elementIdsCsv=${[targetElement.element.id]
            .concat(otherElements.map((e) => e.element.id))
            .join(",")}`
        ).then((v) => {
          setElement(newElement.id, v);
          updateStarterElements((state) => {
            state = state.filter((e) => e.id !== v.id);
            state = state.concat([v]);
            state = state.sort((a, b) => a.name.localeCompare(b.name));
            return state;
          });
          if (!v.imgUrl) {
            fetchAPI(`/get-element?id=${v.id}`).then((updatedValue) => {
              if (updatedValue.imgUrl) {
                setElement(newElement.id, updatedValue);
                updateStarterElements((state) => {
                  state = state.filter((e) => e.id !== updatedValue.id);
                  state = state.concat([updatedValue]);
                  state = state.sort((a, b) => a.name.localeCompare(b.name));
                  return state;
                });
              }
            });
          }
        });
        state = state.concat([newElement]);
        return state;
      })(elements)
    );
  };

  const onFactoryDragStart = (baseElement, e) => {
    e.preventDefault();
    document.getElementsByTagName("html")[0].style.overflow = "hidden";
    setElements(
      ((state) => {
        const newId = (idCnt.current++).toString();
        const newElement = Object.assign(
          {
            x: 0,
            y: 0,
            w: elementW,
            h: elementH,
            hoverEffect: false,
            element: baseElement,
            imgUrl: baseElement.imgUrl,
            name: baseElement.name,
          },
          {
            id: newId,
          }
        );
        dragId.current = newId;
        state = state.concat([newElement]);
        return state;
      })(elements)
    );
  };

  const setElement = (id, element) => {
    setElements((state) => {
      const targetElement = state.find((e) => e.id === id);
      state = state.filter((e) => e.id !== id);
      state = state.concat([
        Object.assign({}, targetElement, {
          element,
          imgUrl: element.imgUrl,
          name: element.name,
          w: elementW,
          h: elementH,
        }),
      ]);
      return state;
    });
  };

  return (
    <div>
      <div style={{ height: "100%", padding: "10px", overflow: "scroll" }}>
        {starterElements.map((se) => (
          <div style={{ paddingBottom: "10px" }}>
            <Element
              key={se.id}
              size={{ w: elementW, h: elementH }}
              onDragStart={(e) => onFactoryDragStart(se, e)}
              onDragStop={(e) => onDragStop(e)}
              hoverEffect={false}
              element={se}
              imgUrl={se.imgUrl}
              name={se.name}
            />
          </div>
        ))}
      </div>
      <div
        style={{
          zIndex: 10,
          position: "absolute",
          top: 0,
          left: 0,
        }}
      >
        {elements.map((element) => (
          <Element
            key={element.id}
            position={{ x: element.x, y: element.y }}
            size={{ w: element.w, h: element.h }}
            onDragStart={(e) => onDragStart(element, e)}
            onDragStop={(e) => onDragStop(e)}
            hoverEffect={element.hoverEffect}
            imgUrl={element.imgUrl}
            name={element.name}
          />
        ))}
      </div>
    </div>
  );
}

export default ElementBox;
