// player-popup.js — geteiltes Modul für das Kurzinfo-Popup beim Spieler-Klick
// (siehe Chat). Eingebunden auf team.html, players.html, index.html (nur
// Injury-Feed-Zeilen) und idp-news.html — überall dort, wo ein Klick auf einen
// Spieler bisher DIREKT zu player.html navigiert hat (nicht auf Seiten, wo der
// Klick schon Teil der Compare-Auswahl ist, z.B. matchups.html/rankings.html).
//
// Bewusst nur mit Daten befüllt, die eh schon über Sleepers Player-Feed
// vorliegen (keine zusätzlichen Netzwerk-Calls nötig): Bio, Depth-Chart-Rang,
// Verletzungsstatus. Vertragsinfos fehlen noch (offene Salary/Role-Frage,
// eigener Punkt auf der Liste) — dafür bewusst ein Platzhalter statt falscher
// Daten. Career-Path-Verlauf würde den schwereren Stats-Abruf brauchen, den
// aktuell nur player.html macht — hier absichtlich (noch) nicht mit drin.

let sleeperAllPromise = null;
function fetchSleeperAllForPopup(){
  if(sleeperAllPromise) return sleeperAllPromise;
  sleeperAllPromise = (async () => {
    const url = 'https://api.sleeper.app/v1/players/nfl';
    const OWN_PROXY = 'https://mim-frontoffice.de/proxy.php?url=';
    const MIM_WORKER = 'https://mics-in-motion.tarik-hurem96.workers.dev/?url=';
    const attempts = [
      url,
      `${OWN_PROXY}${encodeURIComponent(url)}`,
      `${MIM_WORKER}${encodeURIComponent(url)}`,
      `https://proxy.corsfix.com/?${url}`,
      `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    ];
    for(const a of attempts){
      try{
        const r = await fetch(a);
        if(!r.ok) continue;
        const data = await r.json();
        if(data && Object.keys(data).length > 100){
          console.log(`[PlayerPopup] Sleeper Player-Feed geladen (${Object.keys(data).length} Spieler) via`, a.slice(0,50));
          return data;
        }
      }catch(e){ console.warn('[PlayerPopup] Sleeper-Versuch fehlgeschlagen:', a.slice(0,50), e.message); }
    }
    console.warn('[PlayerPopup] Sleeper Player-Feed konnte nicht geladen werden — Popup bleibt leer.');
    return {};
  })();
  return sleeperAllPromise;
}

let popupEl = null;
function ensurePopupDom(){
  if(popupEl) return popupEl;

  const style = document.createElement('style');
  style.textContent = `
.pp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:998;display:none;}
.pp-overlay.open{display:block;}
.pp-card{position:fixed;z-index:999;width:320px;max-width:calc(100vw - 24px);background:var(--bg2);border:1px solid var(--border);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.35);padding:20px;font-family:'Inter',sans-serif;display:none;}
.pp-card.open{display:block;}
.pp-close{position:absolute;top:10px;right:12px;background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;line-height:1;padding:4px;}
.pp-close:hover{color:var(--text);}
.pp-name{font-family:'Bebas Neue',sans-serif;font-size:26px;letter-spacing:1px;color:var(--text);line-height:1;margin-bottom:6px;padding-right:20px;}
.pp-badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;}
.pp-badge{font-size:11px;font-weight:700;letter-spacing:.5px;padding:3px 9px;border-radius:5px;font-family:'Inter',sans-serif;}
.pp-b-team{background:var(--orange-glow);color:var(--orange);border:1px solid var(--orange-dim);}
.pp-b-pos{background:var(--bg3);color:var(--text);border:1px solid var(--border2);}
.pp-b-ok{background:rgba(46,160,67,.12);color:var(--green-light,#2ea043);border:1px solid rgba(46,160,67,.25);}
.pp-b-inj{background:rgba(218,54,51,.12);color:var(--red,#da3633);border:1px solid rgba(218,54,51,.25);}
.pp-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;}
.pp-item{font-size:12px;}
.pp-item-lbl{color:var(--muted);text-transform:uppercase;letter-spacing:.5px;font-size:10px;margin-bottom:2px;}
.pp-item-val{color:var(--text);font-weight:600;}
.pp-section{border-top:1px solid var(--border);padding-top:12px;margin-top:2px;}
.pp-section-lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
.pp-section-val{font-size:13px;color:var(--text);}
.pp-placeholder{font-size:12px;color:var(--muted);font-style:italic;}
.pp-footer{margin-top:16px;text-align:center;}
.pp-footer a{display:inline-block;font-size:12px;font-weight:600;color:var(--orange);text-decoration:none;padding:8px 16px;border:1px solid var(--orange-dim);border-radius:6px;transition:all .15s;}
.pp-footer a:hover{background:var(--orange-glow);}
`;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'pp-overlay';
  overlay.id = 'pp-overlay';
  document.body.appendChild(overlay);

  const card = document.createElement('div');
  card.className = 'pp-card';
  card.id = 'pp-card';
  card.innerHTML = `<button class="pp-close" id="pp-close" aria-label="Schließen">✕</button><div id="pp-content"></div>`;
  document.body.appendChild(card);

  function close(){
    overlay.classList.remove('open');
    card.classList.remove('open');
  }
  overlay.addEventListener('click', close);
  card.querySelector('#pp-close').addEventListener('click', close);
  document.addEventListener('keydown', e => { if(e.key === 'Escape') close(); });
  window._ppClose = close;

  popupEl = card;
  return card;
}

// Position: möglichst nah am angeklickten Element, aber immer im Sichtbereich.
function positionCard(card, anchorEl){
  const rect = anchorEl.getBoundingClientRect();
  const cardW = 320, margin = 12;
  let left = rect.left;
  let top = rect.bottom + 8;
  if(left + cardW + margin > window.innerWidth) left = window.innerWidth - cardW - margin;
  if(left < margin) left = margin;
  if(top + 300 > window.innerHeight) top = Math.max(margin, rect.top - 300 - 8);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function fmtHeight(h){
  if(!h) return '–';
  const n = parseInt(h, 10);
  if(!n) return h;
  return `${Math.floor(n/12)}'${n%12}"`;
}

async function showPlayerPopup(sleeperId, anchorEl){
  const card = ensurePopupDom();
  const overlay = document.getElementById('pp-overlay');
  const content = card.querySelector('#pp-content');
  content.innerHTML = `<div style="padding:30px 0;text-align:center;color:var(--muted);font-size:12px;">Lade…</div>`;
  overlay.classList.add('open');
  card.classList.add('open');
  positionCard(card, anchorEl);

  const all = await fetchSleeperAllForPopup();
  const p = all[sleeperId];
  if(!p){
    content.innerHTML = `<div style="padding:20px 0;text-align:center;color:var(--muted);font-size:12px;">Spieler nicht gefunden.</div>`;
    return;
  }

  const hasInjury = p.injury_status && p.injury_status !== '';
  const statusBadge = hasInjury
    ? `<span class="pp-badge pp-b-inj">${p.injury_status}${p.injury_body_part ? ' · ' + p.injury_body_part : ''}</span>`
    : `<span class="pp-badge pp-b-ok">Aktiv</span>`;

  const depthTxt = p.depth_chart_position
    ? `${p.depth_chart_position}${p.depth_chart_order ? ' · Rang ' + p.depth_chart_order : ''}`
    : '–';

  content.innerHTML = `
    <div class="pp-name">${p.full_name || `${p.first_name||''} ${p.last_name||''}`.trim()}</div>
    <div class="pp-badges">
      <span class="pp-badge pp-b-team">${p.team || '–'}</span>
      <span class="pp-badge pp-b-pos">${p.position || '–'}${p.number ? ' #' + p.number : ''}</span>
      ${statusBadge}
    </div>
    <div class="pp-grid">
      <div class="pp-item"><div class="pp-item-lbl">Alter</div><div class="pp-item-val">${p.age || '–'}</div></div>
      <div class="pp-item"><div class="pp-item-lbl">Erfahrung</div><div class="pp-item-val">${p.years_exp != null ? p.years_exp + ' J.' : '–'}</div></div>
      <div class="pp-item"><div class="pp-item-lbl">Größe</div><div class="pp-item-val">${fmtHeight(p.height)}</div></div>
      <div class="pp-item"><div class="pp-item-lbl">Gewicht</div><div class="pp-item-val">${p.weight ? p.weight + ' lbs' : '–'}</div></div>
      <div class="pp-item" style="grid-column:1/-1;"><div class="pp-item-lbl">College</div><div class="pp-item-val">${p.college || '–'}</div></div>
    </div>
    <div class="pp-section">
      <div class="pp-section-lbl">Depth Chart</div>
      <div class="pp-section-val">${depthTxt}</div>
    </div>
    <div class="pp-section">
      <div class="pp-section-lbl">Vertrag</div>
      <div class="pp-placeholder">Noch nicht verfügbar</div>
    </div>
    <div class="pp-footer">
      <a href="player.html?id=${encodeURIComponent(sleeperId)}">Vollständiges Profil →</a>
    </div>
  `;
}

// Bindet das Popup an alle <a href="player.html?id=..."> Elemente innerhalb
// von rootEl (Standard: ganzes Dokument), die (noch) kein data-no-popup tragen.
// Erneutes Aufrufen ist sicher (z.B. nach dynamischem Nachladen von Zeilen) —
// bereits gebundene Links werden übersprungen.
export function wirePlayerPopupLinks(rootEl){
  const root = rootEl || document;
  root.querySelectorAll('a[href*="player.html?id="]:not([data-popup-wired])').forEach(a => {
    if(a.hasAttribute('data-no-popup')) return;
    a.setAttribute('data-popup-wired', '1');
    a.addEventListener('click', (ev) => {
      const url = new URL(a.href, location.href);
      const id = url.searchParams.get('id');
      if(!id) return;
      ev.preventDefault();
      showPlayerPopup(id, a);
    });
  });
}

export { showPlayerPopup };
