import React, { useState, useEffect, useRef } from "react";
import Element from "./Element";
import { isTouchCapable, enableScroll, disableScroll } from "../lib/touch";
import { useGetFetch } from "../lib/api";
import { findIntersections, averagePosition } from "../lib/coords";
import Swal from "sweetalert2";
import withReactContent from "sweetalert2-react-content";
import {
  Stat,
  StatLabel,
  StatNumber,
  HStack,
  InputGroup,
  InputRightElement,
  Input,
  Box,
  Button,
  Flex,
  Spacer,
} from "@chakra-ui/react";
import { SearchIcon, ExternalLinkIcon } from "@chakra-ui/icons";

const swal = withReactContent(Swal);

function ElementBox({
  starterElements,
  updateStarterElements,
  resetStarterElements,
  stats,
  pollStats,
  elementW,
  elementH,
}) {
  const idCnt = useRef(0);
  const dragId = useRef(null);
  const [elements, setElements] = useState([]);
  const [fetchAPI] = useGetFetch();
  const [search, setSearch] = useState("");

  const maxElementY = elements.reduce((acc, el) => Math.max(acc, el.y), 0);

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
      window.addEventListener("touchmove", onTouch, { passive: false });
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
    disableScroll();
    dragId.current = element.id;
  };

  const onDragStop = (e) => {
    if (dragId.current === null) return;
    e.preventDefault();
    enableScroll();
    const otherIds = findIntersections(elements, dragId.current);
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
        const newPos = averagePosition(otherElements.concat([targetElement]));
        const newElement = Object.assign({}, targetElement, {
          id: (idCnt.current++).toString(),
          element: null,
          imgUrl: null,
          x: newPos.x,
          y: newPos.y,
          name: "unknown",
        });
        fetchAPI(
          `/combine-elements?elementIdsCsv=${[targetElement.element.id]
            .concat(otherElements.map((e) => e.element.id))
            .join(",")}`
        ).then((v) => {
          if (v.isNewElement) {
            swal.fire({
              title: `${v.name}`,
              text: `Congrats! You are the first person to discover ${v.name}.`,
              html: null,
            });
            pollStats();
          }
          setElement(newElement.id, v);
          if (!v.imgUrl) {
            let imgInterval;
            const checkImg = () => {
              fetchAPI(`/get-element?id=${v.id}`)
                .then((updatedValue) => {
                  if (updatedValue.imgUrl) {
                    setElement(newElement.id, updatedValue);
                    clearInterval(imgInterval);
                  }
                })
                .catch(console.error);
            };
            checkImg();
            imgInterval = setInterval(checkImg, 10000);
          }
        });
        state = state.concat([newElement]);
        return state;
      })(elements)
    );
  };

  const onFactoryDragStart = (baseElement, e) => {
    e.preventDefault();
    disableScroll();
    setElements(
      ((state) => {
        const newId = (idCnt.current++).toString();
        const newElement = Object.assign(
          {
            x: e.pageX,
            y: e.pageY,
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
    updateStarterElements((state) => {
      state = state.filter((e) => e.id !== element.id);
      state = state.concat([element]);
      state = state.sort((a, b) => a.name.localeCompare(b.name));
      return state;
    });
  };

  // hack way to refresh icons that timeout
  const oneTimeIconRefresh = useRef(false);
  useEffect(() => {
    if (starterElements && !oneTimeIconRefresh.current) {
      oneTimeIconRefresh.current = true;
      starterElements.forEach((element) => {
        if (!element.imgUrl) {
          fetchAPI(`/get-element?id=${element.id}`).then((updatedValue) => {
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
    }
  }, [fetchAPI, updateStarterElements, starterElements]);

  const clear = () => {
    setElements([]);
    setSearch("");
  };

  const restart = () => {
    clear();
    resetStarterElements();
  };

  return (
    <div>
      <HStack bgColor={"#2D3748"} color={"#fff"} p={2}>
        <span>
          Infinite Alchemy <br />
          <i>
            NOTE: Hit the OpenAI billing limit, new elements wont combine (to be
            fixed soon)
          </i>
        </span>
        <Spacer />
        <Box fontSize={"0.8rem"}>
          <a href="https://github.com/sshh12/llm_alchemy">
            GitHub <ExternalLinkIcon />
          </a>
        </Box>
      </HStack>

      <hr />
      <HStack padding={"20px"}>
        <Stat>
          <StatLabel>Your Elements</StatLabel>
          <StatNumber>{starterElements.length}</StatNumber>
        </Stat>
        <Stat>
          <StatLabel>Total Known Elements</StatLabel>
          <StatNumber>{stats?.totalElements || "-"}</StatNumber>
        </Stat>
      </HStack>
      <hr />

      <Flex
        direction="row"
        spacing={4}
        align="center"
        padding={"10px"}
        textAlign={"center"}
      >
        <Button colorScheme="red" variant="outline" onClick={() => restart()}>
          Restart
        </Button>
        <Spacer />
        <Button colorScheme="blue" variant="outline" onClick={() => clear()}>
          Clear
        </Button>
      </Flex>
      <hr />

      <Box padding={"10px"}>
        <InputGroup maxWidth={"30rem"}>
          <InputRightElement pointerEvents="none">
            <SearchIcon color="gray.300" />
          </InputRightElement>
          <Input
            type="input"
            placeholder="Elements"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
      </Box>

      <div
        style={{
          height: "100%",
          padding: "10px",
          overflow: "scroll",
          minHeight: `${Math.max(maxElementY, window.innerHeight)}px`,
        }}
      >
        {starterElements
          .filter(
            (se) =>
              search === "" ||
              se.name.toLowerCase().includes(search.toLowerCase())
          )
          .map((se) => (
            <div key={se.id} style={{ paddingBottom: "10px" }}>
              <Element
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
