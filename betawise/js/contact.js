// contact.js — preselect the inquiry type from ?type=partnership|investor|press.
const type = new URLSearchParams(location.search).get('type');
const select = document.getElementById('inquiry');
if (type && select.querySelector(`option[value="${CSS.escape(type)}"]`)) select.value = type;
