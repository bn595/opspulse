// Applied before first paint so the saved theme doesn't flash.
try {
  var t = localStorage.getItem('opspulse.theme');
  if (t === '"light"' || t === '"dark"') document.documentElement.setAttribute('data-theme', JSON.parse(t));
} catch (e) { /* storage unavailable */ }
