import React from "react";
import { isTouchCapable } from "../lib/touch";

function Element({ onDragStart, onDragStop, position, size }) {
  const onProps = isTouchCapable
    ? { onTouchStart: (e) => onDragStart(), onTouchEnd: (e) => onDragStop() }
    : { onMouseDown: (e) => onDragStart(), onMouseUp: (e) => onDragStop() };
  return (
    <div
      {...onProps}
      style={{
        backgroundColor: "#ff00ff",
        width: size.w + "px",
        height: size.h + "px",
        left: position.x - 50 + "px",
        top: position.y - 50 + "px",
        position: "absolute",
      }}
    >
      Test
    </div>
  );
}

export default Element;
