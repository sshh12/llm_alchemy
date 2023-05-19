import React from "react";
import { isTouchCapable } from "../lib/touch";

function Element({
  onDragStart,
  onDragStop,
  position,
  size,
  hoverEffect,
  element,
  name,
}) {
  const onProps = isTouchCapable
    ? { onTouchStart: (e) => onDragStart(), onTouchEnd: (e) => onDragStop() }
    : { onMouseDown: (e) => onDragStart(), onMouseUp: (e) => onDragStop() };
  return (
    <div
      {...onProps}
      style={{
        backgroundColor: hoverEffect ? "#0000ff" : "#ff00ff",
        width: size.w + "px",
        height: size.h + "px",
        left: position.x - 50 + "px",
        top: position.y - 50 + "px",
        position: "absolute",
      }}
    >
      {element.name} {name}
      <img
        alt={element?.name}
        src={element?.imgUrl}
        width={size.w - 10 + "px"}
        height={size.h - 10 + "px"}
      />
    </div>
  );
}

export default Element;
