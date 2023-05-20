import { useState, useEffect } from "react";

export function useDefaultPersistentGet(key, path) {
  const [values, setValues] = useState(null);
  useEffect(() => {
    const store = localStorage.getItem(key);
    if (!store) {
      fetch("/.netlify/functions" + path)
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
  return [values, setVals];
}

export function useGetFetch() {
  const fetchValues = (path) => {
    return fetch("/.netlify/functions" + path)
      .then((resp) => resp.json())
      .then((values) => {
        return values;
      });
  };
  return [fetchValues];
}
