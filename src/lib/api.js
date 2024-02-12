import { useState, useEffect, useCallback, useRef } from "react";

const BASE_URL =
  window.location.hostname === "localhost" ? "http://localhost:9999" : "";

export function useDefaultPersistentGet(key, path) {
  const [values, setValues] = useState(null);
  useEffect(() => {
    const store = localStorage.getItem(key);
    if (!store) {
      fetch(`${BASE_URL}/.netlify/functions${path}`)
        .then((resp) => resp.json())
        .then((values) => {
          setValues(values);
          localStorage.setItem(key, JSON.stringify(values));
        });
    } else {
      setValues(JSON.parse(store));
    }
  }, [path, key]);
  const setVals = (newValue) => {
    setValues((s) => {
      const val = newValue(s);
      localStorage.setItem(key, JSON.stringify(val));
      return val;
    });
  };
  const reset = () => {
    fetch(`${BASE_URL}/.netlify/functions${path}`)
      .then((resp) => resp.json())
      .then((values) => {
        setValues(values);
        localStorage.setItem(key, JSON.stringify(values));
      });
  };
  return [values, setVals, reset];
}

export function usePollingGet(path) {
  const [values, setValues] = useState(null);
  useEffect(() => {
    fetch(`${BASE_URL}/.netlify/functions${path}`)
      .then((resp) => resp.json())
      .then((values) => {
        setValues(values);
      });
  }, [path]);
  const poll = () => {
    fetch(`${BASE_URL}/.netlify/functions${path}`)
      .then((resp) => resp.json())
      .then((values) => {
        setValues(values);
      });
  };
  return [values, poll];
}

export function useGetFetch() {
  const fetchValues = (path) => {
    return fetch(`${BASE_URL}/.netlify/functions${path}`)
      .then((resp) => resp.json())
      .then((values) => {
        return values;
      });
  };
  return [fetchValues];
}

export function useLocalStorage(key, makeDefault) {
  let [val, _setVal] = useState(JSON.parse(localStorage.getItem(key))?.value);
  const setVal = useCallback(
    (v) => {
      localStorage.setItem(key, JSON.stringify({ value: v }));
      _setVal(v);
    },
    [key]
  );
  const makeDefaultRef = useRef(makeDefault);
  useEffect(() => {
    const curVal = localStorage.getItem(key);
    if (!curVal) {
      setVal(makeDefaultRef.current());
    } else {
      setVal(JSON.parse(curVal).value);
    }
  }, [key, setVal, makeDefaultRef]);
  return [val, setVal];
}

export function getDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate() + 1).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
