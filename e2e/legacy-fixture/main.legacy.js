// Stand-in for the 2023 app bundle: persists player state the way the old React hooks did
// (useLocalStorage JSON values) and registers the Workbox service worker on load, like CRA's
// serviceWorkerRegistration.register() in production builds.
(function () {
  var state = JSON.parse(document.getElementById("legacy-state").textContent);
  if (!localStorage.getItem("alchemy:userId")) {
    localStorage.setItem("alchemy:userId", JSON.stringify({ value: state.userId }));
  }
  if (!localStorage.getItem("elements")) {
    localStorage.setItem("elements", JSON.stringify(state.elements));
  }
  localStorage.setItem("infomodal:closed", "true");

  var list = document.getElementById("legacy-elements");
  JSON.parse(localStorage.getItem("elements")).forEach(function (el) {
    var li = document.createElement("li");
    li.textContent = el.name;
    list.appendChild(li);
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/service-worker.js");
    });
  }
})();
