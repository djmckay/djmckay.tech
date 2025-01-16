
function cookiesConfirmed() {
$('#cookie-footer').hide();
var d = new Date();
d.setTime(d.getTime() + (365*24*60*60*1000));
var expires = "expires="+ d.toUTCString();
document.cookie = "cookies-accepted=true;" + expires;
}

function fetchData() {

  fetch("https://m081tuazhj.execute-api.us-east-1.amazonaws.com/default/djmckay_tech_counter", {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  })
    .then((response) => response.json())
    .then((json) => takeData(json));
}

function takeData(val) {

  document.getElementById('visitor').innerHTML = val.Attributes.numberOfVisitors;
}

fetchData();
