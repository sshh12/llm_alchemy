import { useState, useEffect } from "react";

export function useGet(path) {
  const [values, setValues] = useState(null);
  useEffect(() => {
    fetch("/.netlify/functions" + path)
      .then((resp) => resp.json())
      .then((values) => {
        setValues(values);
      });
  }, [path]);
  return [values];
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
