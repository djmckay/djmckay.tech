// The visitor count, from a Lambda and DynamoDB table that predate this site. The call both increments the
// count and returns it, so one request per page load is the whole thing.
//
// It stayed silent for a while: the old site's script survived the rebuild but nothing ever loaded it and the
// element it wrote into was not carried over, so the count sat frozen while the page looked fine. Hence the
// two rules here. The line stays hidden until a real number arrives, so a failure reads as absence rather than
// as a broken counter. And nothing is logged when it fails, because a visitor count is the least important
// thing on the page and has no business filling anyone's console.
(function () {
  var line = document.getElementById("visitors");
  var value = document.getElementById("visitor-count");
  if (!line || !value || typeof fetch !== "function") return;
  var API = line.dataset.counter; // set from site.json, so moving the endpoint is a config change
  if (!API) return;

  fetch(API, { method: "POST", headers: { "content-type": "application/json" } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (body) {
      var n = Number(body && body.numberOfVisitors);
      if (!isFinite(n) || n <= 0) return;
      value.textContent = n.toLocaleString();
      line.removeAttribute("hidden");
    })
    .catch(function () { /* the count is not worth an error anyone has to look at */ });
})();
