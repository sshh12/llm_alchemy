import { useState, useEffect, useCallback, useRef } from "react";

const BASE_URL = "https://alchemy.sshh.io";

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
  let [val, _setVal] = useState(null);
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
