import React from "react";
import { isTouchCapable } from "../lib/touch";

function Element({
  onDragStart,
  onDragStop,
  position,
  size,
  hoverEffect,
  imgUrl,
  name,
}) {
  const onProps = isTouchCapable
    ? { onTouchStart: (e) => onDragStart(e), onTouchEnd: (e) => onDragStop(e) }
    : { onMouseDown: (e) => onDragStart(e), onMouseUp: (e) => onDragStop(e) };
  const positionProps = position
    ? {
        left: position.x - 50 + "px",
        top: position.y - 50 + "px",
        position: "absolute",
      }
    : {};
  return (
    <div
      {...onProps}
      style={{
        backgroundColor: hoverEffect ? "#555" : "#eee",
        width: size.w + "px",
        height: size.h + "px",
        padding: "5px",
        borderRadius: "5px",
        ...positionProps,
      }}
    >
      <span
        style={{
          whiteSpace: "nowrap",
          maxWidth: size.w + "px",
        }}
      >
        <b>{name}</b>
      </span>
      <img
        alt={""}
        src={imgUrl}
        width={size.w - 18 + "px"}
        height={size.h - 18 + "px"}
      />
    </div>
  );
}

export default Element;
