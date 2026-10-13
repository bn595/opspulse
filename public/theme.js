// Applies the saved theme before first paint.
try {
  var t = localStorage.getItem('opspulse.theme');
  if (t === '"light"' || t === '"dark"') document.documentElement.setAttribute('data-theme', JSON.parse(t));
} catch (e) { /* storage unavailable */ }
