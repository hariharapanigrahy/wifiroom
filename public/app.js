// The app shell: which pane is showing (sidebar on laptops, tab bar on phones). Loaded before the rest.
const PANES = ['room', 'chats', 'program', 'games', 'files', 'people'];
function showPane(name) {
  if (!PANES.includes(name)) return;
  for (const p of PANES) {
    document.getElementById(`pane-${p}`).classList.toggle('on', p === name);
    document.querySelector(`.navbtn[data-pane="${p}"]`).classList.toggle('on', p === name);
  }
  document.getElementById('chats').classList.toggle('open', name === 'chats');
  document.body.dataset.pane = name;
  if (name === 'chats' && typeof renderChats === 'function') renderChats();
  if (name === 'room') window.roomGame?.scale.refresh();
  window.dispatchEvent(new CustomEvent('pane', { detail: name }));
}
document.querySelectorAll('.navbtn').forEach((b) => (b.onclick = () => showPane(b.dataset.pane)));
