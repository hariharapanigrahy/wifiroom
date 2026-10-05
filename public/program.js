// Program, Games and People panes, as Preact components (htm + Preact, no build step).
import { html, render } from '/lib/htm-preact.js';

// ---- People: everyone known to the host's channels, online first ----
function People() {
  const people = Object.entries(window.ch?.people ?? {}).map(([id, p]) => ({ id, ...p })).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  if (!people.length) return html`<div class="empty"><div style="font-size:40px">👥</div><p>Nobody has joined channels yet. Open Chats and pick a name.</p></div>`;
  return html`<div>
    <h3>${people.filter((p) => p.online).length} here now</h3>
    ${people.map((p) => html`<div class="chat-row" key=${p.id}><span>${p.online ? '🟢' : '⚪'}</span><span class="who">${p.name}${p.id === window.ch?.me ? ' (you)' : ''}<div>${p.online ? 'online' : `last seen ${new Date(p.seen).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</div></span></div>`)}
  </div>`;
}

const Soon = ({ icon, title, lines }) => html`<div class="empty"><div style="font-size:40px">${icon}</div><p><b>${title}</b></p>${lines.map((l) => html`<p class="note">${l}</p>`)}</div>`;
const Program = () => html`<${Soon} icon="📅" title="Program: coming next" lines=${['Schedule with Now / Next, announcements, polls and sign-ups.', 'Kept on the host device, like channels.']} />`;
const Games = () => html`<${Soon} icon="🎲" title="Games: coming after Program" lines=${['Buzzer quiz, bingo, "most likely to", and board games.', 'Lobbies and scoreboards per game night.']} />`;

const draw = () => {
  render(html`<${People} />`, document.getElementById('people'));
  render(html`<${Program} />`, document.getElementById('program'));
  render(html`<${Games} />`, document.getElementById('games'));
};
draw();
window.addEventListener('pane', draw);
if (window.socket) window.socket.on('channels', draw);
