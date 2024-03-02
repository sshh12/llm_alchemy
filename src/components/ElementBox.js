import React, { useState, useEffect, useRef } from "react";
import Element from "./Element";
import { isTouchCapable, enableScroll, disableScroll } from "../lib/touch";
import { useGetFetch, getDate } from "../lib/api";
import { findIntersections, averagePosition } from "../lib/coords";
import Swal from "sweetalert2";
import withReactContent from "sweetalert2-react-content";
import {
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
import ChallengeDetails from "./ChallengeDetails";
import OverviewDetails from "./OverviewDetails";

const swal = withReactContent(Swal);
const DOUBLE_CLICK_MS = 150;

function ElementBox({
  starterElements,
  updateStarterElements,
  resetStarterElements,
  stats,
  userId,
  pollStats,
  elementW,
  elementH,
}) {
  const idCnt = useRef(0);
  const dragId = useRef(null);
  const [elements, setElements] = useState([]);
  const [fetchAPI] = useGetFetch();
  const [search, setSearch] = useState("");
  const [credits, setCredits] = useState(stats?.credits);
  const [pinnedElementIds, setPinnedElementIds] = useState([]);

  useEffect(() => {
    setCredits(stats?.credits || 0);
  }, [stats]);

  useEffect(() => {
    window.newElementLastClick = 0;
    window.newElementTimeout = null;
  }, []);

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
    window.gtag("event", "element_combined", {
      numElements: otherIds.length + 1,
    });
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
        const date = getDate();
        fetchAPI(
          `/combine-elements?userId=${userId}&date=${date}&elementIdsCsv=${[
            targetElement.element.id,
          ]
            .concat(otherElements.map((e) => e.element.id))
            .join(",")}`
        ).then((v) => {
          if (v.errorMessage) {
            alert(
              "Failed to combine elements! It's possible this is a big or this project is out of OpenAI credits. Refresh and try again."
            );
            return;
          } else if (v.error) {
            alert(v.error);
            setCredits(v.creditsLeft);
            return;
          } else if (v.isNewElement) {
            swal.fire({
              title: `${v.name}`,
              text: `Congrats! You are the first person to discover ${v.name}.`,
              html: null,
            });
            window.gtag("event", "element_new", {
              element: v.name,
            });
            pollStats();
          } else if (v.challengeCredits > 0) {
            showChallengeComplete(v.challengeCredits);
            window.gtag("event", "challenge_complete", {
              element: v.name,
            });
            window.gtag(
              "event",
              `challenge_complete_${v.challengeLevelComplete}`,
              {
                element: v.name,
              }
            );
            pollStats();
          }
          if (v.creditsLeft) {
            setCredits(v.creditsLeft);
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

    const now = +Date.now();

    if (now - window.lastClick < DOUBLE_CLICK_MS) {
      clearTimeout(window.newElementTimeout);
      setPinnedElementIds((state) => {
        if (state.includes(baseElement.id)) {
          state = state.filter((id) => id !== baseElement.id);
        } else {
          state = state.concat([baseElement.id]);
        }
        return state;
      });
    } else {
      window.newElementTimeout = setTimeout(() => {
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
      }, DOUBLE_CLICK_MS);
    }

    window.lastClick = now;
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
    window.gtag("event", "element_cleared");
    setElements([]);
    setSearch("");
  };

  const restart = () => {
    clear();
    resetStarterElements();
  };

  const showChallengeComplete = (challengeCredits) => {
    swal.fire({
      title: `Daily Challenge Complete`,
      text: `Congrats! You recieved ${challengeCredits} free credits for completing the daily challenge.`,
    });
  };

  return (
    <div>
      <HStack bgColor={"#2D3748"} color={"#fff"} p={2}>
        <span>Infinite Alchemy</span>
        <span></span>
        <Spacer />
        <Box fontSize={"0.8rem"}>
          <a href="https://github.com/sshh12/llm_alchemy">
            GitHub <ExternalLinkIcon />
          </a>
        </Box>
      </HStack>

      <hr />

      <OverviewDetails
        stats={stats}
        starterElements={starterElements}
        userId={userId}
        credits={credits}
      />

      <hr />

      <ChallengeDetails stats={stats} />

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
            placeholder="Elements (double tap elements to pin)"
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
          .sort(
            (a, b) =>
              pinnedElementIds.includes(b.id) * 10000 -
              pinnedElementIds.includes(a.id) * 10000 +
              a.name.localeCompare(b.name)
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
                pinned={pinnedElementIds.includes(se.id)}
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
            pinned={false}
          />
        ))}
      </div>
    </div>
  );
}

export default ElementBox;
