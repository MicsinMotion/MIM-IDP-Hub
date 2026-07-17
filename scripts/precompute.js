// ═══════════════════════════════════════════════════════════════════════════
// MICS IN MOTION — Precompute-Skript (läuft via GitHub Actions, NICHT im Browser)
// ═══════════════════════════════════════════════════════════════════════════
// Rechnet Team Stats + Lineup Details für alle 32 Teams EINMAL zentral und
// schreibt das Ergebnis in denselben Firestore-"shared_cache", den team.html/
// league.html schon lesen — Besucher müssen dann nie mehr selbst rechnen.
//
// Die eigentliche Berechnungslogik (parseCsvLine bis computeLineupDataForSeason
// weiter unten) ist 1:1 aus team.html portiert — bewusst NICHT neu geschrieben,
// damit Browser und Server garantiert dasselbe Ergebnis liefern.
//
// Aufruf lokal zum Testen:  node scripts/precompute.js [jahr]
// (ohne Jahr-Argument: aktuelle Saison, siehe CURRENT_SEASON_YEAR unten)

const admin = require('firebase-admin');

// ─── Firebase Admin SDK initialisieren ──────────────────────────────────────
// FIREBASE_SERVICE_ACCOUNT muss als GitHub Secret hinterlegt sein (kompletter
// JSON-Inhalt des Service-Account-Schlüssels als EIN String) — siehe README.
if(!process.env.FIREBASE_SERVICE_ACCOUNT){
  console.error('FEHLER: Umgebungsvariable FIREBASE_SERVICE_ACCOUNT fehlt. Siehe scripts/README.md.');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function saveSharedCache(key, data){
  await db.collection('shared_cache').doc(key).set({ ...data, updatedAt: Date.now() }, { merge: true });
}

// ─── Jahr-Logik (identisch zu team.html) ────────────────────────────────────
function isPastMarch1(d){ return d >= new Date(d.getFullYear(), 2, 1); }
const CURRENT_SEASON_YEAR = isPastMarch1(new Date()) ? new Date().getFullYear() : new Date().getFullYear() - 1;
const MIN_YEAR = 2022;

function parseCsvLine(line){
  // einfacher CSV-Parser, der auch Felder mit Kommas in Anführungszeichen korrekt behandelt
  const out = []; let cur = ''; let inQ = false;
  for(let i=0;i<line.length;i++){
    const c = line[i];
    if(c === '"'){ inQ = !inQ; continue; }
    if(c === ',' && !inQ){ out.push(cur); cur=''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Eigener Cloudflare Worker — dauerhaft zuverlässig, da er uns gehört (siehe Chat).
// Wird von mehreren Funktionen geteilt (nflverse-CSV, ourlads).
const MIM_WORKER = 'https://mics-in-motion.tarik-hurem96.workers.dev/?url=';

async function fetchNflverseCSV(url){
  // Serverseitig (GitHub Actions) gibt es KEIN CORS-Problem — direkter Fetch
  // zuerst, der Worker/Proxy-Umweg (nur für den Browser gedacht) dient hier nur
  // als seltene Rückfallebene, falls GitHub selbst mal kurz blockt.
  const attempts = [url, `${MIM_WORKER}${encodeURIComponent(url)}`];
  for(const a of attempts){
    try{
      const r = await fetch(a);
      if(!r.ok) continue;
      const text = await r.text();
      if(text && text.length > 100) return text;
    }catch(e){}
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// TEAM ROSTER — nflverse Rosters (Kader/Bio je Saison) + PFF (genaue Position,
// 5-Wege-Split DI/ED/LB/CB/S) + nflverse/PFR Snap Counts (Snap%, wie in
// player.html) + Sleeper (Weekly Stats → Season Stats & Fantasy Points).
// ══════════════════════════════════════════════════════════════════════════

const NV_ROSTER_URL = yr => `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${yr}.csv`;
const NV_SNAP_URL = yr => `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${yr}.csv`;

// PFF Team-Rosters — liefert die genaue Position (DI/ED statt fälschlich DT/OLB).
const PFF_TEAM_ID={ARI:1,ATL:2,BAL:3,BUF:4,CAR:5,CHI:6,CIN:7,CLE:8,DAL:9,DEN:10,DET:11,GB:12,HOU:13,IND:14,JAX:15,KC:16,MIA:17,MIN:18,NE:19,NO:20,NYG:21,NYJ:22,LV:23,PHI:24,PIT:25,LAR:26,LAC:27,SF:28,SEA:29,TB:30,TEN:31,WAS:32,LA:26};
const PFF_POS_MAP={DI:'DI',ED:'ED',LB:'LB',CB:'CB',S:'S',FS:'S',SS:'S'};

// Fallback-Zuordnung (nflverse depth_chart_position/position → 5-Wege-Split), falls
// PFF für einen Spieler nichts liefert (z.B. gerade verpflichtet, Practice Squad).
function classifyIdpGroup(pffPos, dcp, pos){
  if(pffPos && ['DI','ED','LB','CB','S'].includes(pffPos)) return pffPos;
  const t = (dcp || pos || '').toUpperCase();
  if(['DT','NT','DL'].includes(t)) return 'DI';
  if(['DE','EDGE','OLB'].includes(t)) return 'ED'; // OLB zählt zu ED (siehe Chat, konsistent mit Lineup Details)
  if(['LB','ILB','MLB'].includes(t)) return 'LB';
  if(t === 'CB') return 'CB';
  if(['S','FS','SS','DB'].includes(t)) return 'S';
  return null; // Offense/Special Teams — für die IDP-Roster-Ansicht nicht relevant
}

// NEUE Priorität (siehe Chat): PFF zuerst. Liefert PFF nichts, nutzen wir Sleepers
// eigenen fantasy_positions-Tag als Indikator, BEVOR wir überhaupt nflverse
// anfassen — kein "OLB"-Rätselraten mehr nötig:
//   - Sleeper führt SOWOHL "DL" ALS AUCH "LB" → Tweener-Edge-Rusher (z.B. Kyle Van
//     Noy) → ED. Genau dieser Doppel-Tag ist der verlässliche Indikator, den
//     nflverses einzelnes "OLB"-Label nicht liefern kann.
//   - Sleeper führt NUR "LB" (kein DL) → klassischer Off-Ball-Backer (z.B. Devin
//     White) → LB, fertig, kein nflverse nötig.
//   - Sleeper führt NUR "DL" (kein LB) → generischer Lineman-Tag, nflverse für die
//     genaue Sorte (DT/NT → DI, DE → ED) konsultieren.
//   - Sleeper führt "DB" → nflverse für CB vs. S konsultieren.
//   - Nichts davon eindeutig → alter dcp/pos-Fallback als letzte Rettung.
function classifyViaSleeperTag(pffPos, fantasyPositions, dcp, pos){
  if(pffPos && ['DI','ED','LB','CB','S'].includes(pffPos)) return pffPos;

  const tags = new Set((fantasyPositions||[]).map(t => (t||'').toUpperCase()));
  const hasDL = tags.has('DL'), hasLB = tags.has('LB'), hasDB = tags.has('DB');

  if(hasDL && hasLB) return 'ED';
  if(hasLB) return 'LB';
  if(hasDL){
    const t = (dcp || pos || '').toUpperCase();
    if(['DT','NT'].includes(t)) return 'DI';
    if(['DE','EDGE','OLB'].includes(t)) return 'ED';
    return 'DI'; // generischer DL-Tag ohne genauere nflverse-Angabe — DI als Standardannahme
  }
  if(hasDB){
    const t = (dcp || pos || '').toUpperCase();
    if(t === 'CB') return 'CB';
    if(['S','FS','SS'].includes(t)) return 'S';
    return null; // unklar — lieber nichts zuordnen als raten
  }
  return classifyIdpGroup(null, dcp, pos); // kein/unklarer Sleeper-Tag — alter Fallback als letzte Rettung
}

async function fetchPffRosterMap(abbr){
  const pffMap = new Map(); // pff_id -> genaue Position
  let rawPlayers = [];
  const teamId = PFF_TEAM_ID[abbr];
  if(!teamId) return { pffMap, rawPlayers };
  try{
    const url = `https://www.pff.com/api/teams/${teamId}/roster`;
    const res = await fetchViaWorker(url);
    if(!res) return { pffMap, rawPlayers };
    const json = JSON.parse(res);
    rawPlayers = json.team_players || [];
    rawPlayers.forEach(pl => {
      if(pl.id && pl.position) pffMap.set(String(pl.id), PFF_POS_MAP[pl.position.toUpperCase()] || null);
    });
  }catch(e){ console.warn('[Roster] PFF-Positionen konnten nicht geladen werden:', e); }
  return { pffMap, rawPlayers };
}

// pff_id bevorzugt aus der AKTUELLEN Saison-Rosters-CSV auflösen (sleeper_id ->
// pff_id), nicht nur aus der CSV des gerade ausgewählten Jahres — exakt dasselbe
// Prinzip wie player.html's enrichIds() (dort wird ebenfalls über mehrere Jahre
// gesucht). Grund für den Bug (Jermaine Johnson landete bei LB statt ED): die
// pff_id in älteren Rosters-Snapshots kann veraltet/falsch sein, während die
// aktuelle Saison-CSV die richtige, zu PFFs eigener ID passende pff_id führt.
// WICHTIG (siehe Chat, Devin-White-Fall): das gilt NUR für pff_id/gsis_id, die
// sich über die Jahre nie ändern. Die depth_chart_position/position dagegen
// wird bewusst NICHT mehr hier mehrjährig aufgelöst — die muss exakt aus dem
// gerade angezeigten Jahr kommen (siehe classifyIdpGroup-Aufruf weiter unten),
// sonst rutscht z.B. ein 2026er-Platzhalter-Wert in die 2025er-Anzeige.
let currentYearPffIdMapPromise = null;

function fetchCurrentYearPffIdMap(){
  if(currentYearPffIdMapPromise) return currentYearPffIdMapPromise;
  currentYearPffIdMapPromise = (async () => {
    const map = new Map(); // sleeper_id -> { pff_id, gsis_id }
    const MIN_NV_YEAR = 2022;
    for(let yr = CURRENT_SEASON_YEAR; yr >= MIN_NV_YEAR; yr--){
      const text = await fetchNflverseCSV(NV_ROSTER_URL(yr));
      if(!text) continue;
      const lines = text.split('\n').filter(l => l.trim());
      const H = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
      const iSl = H.indexOf('sleeper_id'), iPf = H.indexOf('pff_id'), iGs = H.indexOf('gsis_id');
      if(iSl < 0) continue;
      for(let i=1;i<lines.length;i++){
        const row = parseCsvLine(lines[i]);
        const sid = (row[iSl]||'').trim();
        if(!sid) continue;
        const pid = iPf>=0 ? (row[iPf]||'').trim() : '';
        const gid = iGs>=0 ? (row[iGs]||'').trim() : '';
        const existing = map.get(sid) || { pff_id: '', gsis_id: '' };
        // Nur befüllen, was noch fehlt — wir gehen absteigend (neuestes Jahr
        // zuerst), ein schon gefundener Wert aus einem neueren Jahr hat also
        // automatisch Vorrang und wird nicht mehr überschrieben.
        if(!existing.pff_id && pid && pid !== 'NA') existing.pff_id = pid;
        if(!existing.gsis_id && gid && gid !== 'NA') existing.gsis_id = gid;
        map.set(sid, existing);
      }
    }
    return map;
  })();
  return currentYearPffIdMapPromise;
}

// ── INJURY-BADGE — identisch zu rankings.html (selbe Klassifizierung, selbe
// Farbgebung), damit Verletzungen im ganzen Projekt einheitlich aussehen. ──
const NV_INJURIES_URL = yr => `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${yr}.csv`;

// ── TEAM STATS — PBP-basiert (Tag "pbp", Datei play_by_play_{jahr}.csv), erstmal
// nur 2025. EIN Fetch deckt automatisch ALLE 32 Teams ab (posteam/defteam-Spalten),
// daraus lassen sich sowohl unsere eigenen Werte als auch die Liga-Ränge berechnen.
// WICHTIG: Größte Datei im ganzen Projekt (372 Spalten, ~48.000 Zeilen/Saison) —
// falls das am Worker/Proxy scheitert, ist das ein Infrastruktur-, kein Logikfehler
// (siehe Chat-Historie zur Contracts-Datei).
const NV_PBP_URL = yr => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${yr}.csv`;

const pbpCsvPromiseByYear = {};
async function fetchPbpCsv(yr){
  if(pbpCsvPromiseByYear[yr]) return pbpCsvPromiseByYear[yr];
  pbpCsvPromiseByYear[yr] = (async () => {
    const rawUrl = NV_PBP_URL(yr);
    for(const url of [
      `${MIM_WORKER}${encodeURIComponent(rawUrl)}`,
      `https://proxy.corsfix.com/?${rawUrl}`,
      `https://api.allorigins.win/get?url=${encodeURIComponent(rawUrl)}`,
      `https://corsproxy.io/?url=${encodeURIComponent(rawUrl)}`,
    ]){
      try{
        const ctrl = new AbortController();
        const timer = setTimeout(()=>ctrl.abort(), 25000); // deutlich mehr Zeit als bei kleineren Dateien
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if(!r.ok){ console.warn(`[TeamStats] PBP HTTP ${r.status} @ ${url.slice(0,60)}`); continue; }
        let t = url.includes('allorigins') ? (await r.json()).contents : await r.text();
        if(t && t.length > 10000 && t.includes('defteam')){
          console.log(`[TeamStats] PBP ${yr} geladen (${(t.length/1e6).toFixed(1)} MB) via ${url.slice(0,60)}`);
          return t;
        }
      }catch(e){ console.warn(`[TeamStats] PBP Fehler @ ${url.slice(0,60)}:`, e.message); }
    }
    return null;
  })();
  return pbpCsvPromiseByYear[yr];
}

// Baut Team-Defense-Aggregate für ALLE Teams aus einem einzigen Durchlauf der PBP.
// ANNAHMEN zu Spaltennamen (Standard-nflfastR-Schema, nicht live verifiziert —
// siehe Konsolen-Log für den tatsächlichen Header, falls was nicht passt):
// posteam, defteam, play_type, yards_gained, epa, success, touchdown, sack,
// interception, fumble_forced, penalty, penalty_team, penalty_yards,
// third_down_converted, third_down_failed, game_id, home_team, away_team,
// total_home_score, total_away_score.
function aggregateTeamDefense(pbpText){
  // nflverse führt die Rams offiziell als "LA" (nicht "LAR") — bestätigt über
  // nflreadr's eigene clean_team_abbrs()-Doku. Der Rest der Seite (TEAMS,
  // PFF_TEAM_ID, Team-Switcher) nutzt durchgehend "LAR", deshalb hier normalisieren,
  // statt an jeder Stelle einen Sonderfall einzubauen (siehe Chat).
  const normalizeAbbr = t => t === 'LA' ? 'LAR' : t;

  const lines = pbpText.split('\n');
  const H = parseCsvLine(lines[0]).map(h => h.trim());
  console.log(`[TeamStats] PBP Header (${H.length} Spalten):`, H);
  const idx = {};
  ['game_id','home_team','away_team','posteam','defteam','play_type','yards_gained','epa','success',
   'touchdown','sack','interception','fumble_forced','penalty','penalty_team','penalty_yards',
   'third_down_converted','third_down_failed','fourth_down_converted','fourth_down_failed',
   'qb_hit','pass_defense_1_player_id','total_home_score','total_away_score'
  ].forEach(k => idx[k] = H.indexOf(k));

  const teams = {};
  function T(team){
    if(!teams[team]) teams[team] = {
      snaps:0, snapsRun:0, snapsPass:0, yards:0, rushYards:0, rushPlays:0, passYards:0, passPlays:0,
      tds:0, rushTds:0, passTds:0, thirdAtt:0, thirdConv:0, fourthAtt:0, fourthConv:0,
      explosive:0, stuffs:0, epaSum:0, epaPlays:0, successSum:0, successPlays:0,
      sacks:0, ints:0, ff:0, qbHits:0, pbu:0, penalties:0, penaltyYards:0, pointsAllowed:0, games:0,
    };
    return teams[team];
  }
  const gameFinal = {};

  for(let i=1;i<lines.length;i++){
    const line = lines[i];
    if(!line.trim()) continue;
    const c = parseCsvLine(line);
    const gid = idx.game_id>=0 ? c[idx.game_id] : null;
    if(gid){
      const hs = parseFloat(c[idx.total_home_score]), as = parseFloat(c[idx.total_away_score]);
      if(!isNaN(hs) && !isNaN(as)) gameFinal[gid] = { home:normalizeAbbr(c[idx.home_team]), away:normalizeAbbr(c[idx.away_team]), hs, as };
    }

    const defteam = idx.defteam>=0 ? normalizeAbbr(c[idx.defteam]) : null;
    if(!defteam) continue;
    const t = T(defteam);
    const playType = c[idx.play_type];
    const isRun = playType === 'run';
    const isPass = playType === 'pass';
    const isTd = c[idx.touchdown] === '1';
    if(isRun || isPass){
      t.snaps++;
      const yg = parseFloat(c[idx.yards_gained]) || 0;
      t.yards += yg;
      if(isRun){
        t.snapsRun++; t.rushYards += yg; t.rushPlays++;
        if(yg>=10) t.explosive++;
        if(yg<=0) t.stuffs++; // Run Stop Rate: Lauf bei 0 oder weniger Yards gestoppt
        if(isTd) t.rushTds++;
      }
      if(isPass){
        t.snapsPass++; t.passYards += yg; t.passPlays++;
        if(yg>=20) t.explosive++;
        if(isTd) t.passTds++;
      }
      const epaVal = parseFloat(c[idx.epa]);
      if(!isNaN(epaVal)){ t.epaSum += epaVal; t.epaPlays++; }
      if(c[idx.success] !== undefined && c[idx.success] !== ''){ t.successPlays++; if(c[idx.success]==='1') t.successSum++; }
    }
    if(isTd) t.tds++;
    if(c[idx.sack] === '1') t.sacks++;
    if(c[idx.interception] === '1') t.ints++;
    if(c[idx.fumble_forced] === '1') t.ff++;
    if(idx.qb_hit>=0 && c[idx.qb_hit] === '1') t.qbHits++;
    if(idx.pass_defense_1_player_id>=0 && c[idx.pass_defense_1_player_id]) t.pbu++;
    if(c[idx.third_down_converted] === '1'){ t.thirdAtt++; t.thirdConv++; }
    if(c[idx.third_down_failed] === '1'){ t.thirdAtt++; }
    if(idx.fourth_down_converted>=0 && c[idx.fourth_down_converted] === '1'){ t.fourthAtt++; t.fourthConv++; }
    if(idx.fourth_down_failed>=0 && c[idx.fourth_down_failed] === '1'){ t.fourthAtt++; }
    if(idx.penalty>=0 && c[idx.penalty] === '1' && c[idx.penalty_team]){
      const pt = T(normalizeAbbr(c[idx.penalty_team]));
      pt.penalties++;
      if(idx.penalty_yards>=0) pt.penaltyYards += parseFloat(c[idx.penalty_yards]) || 0;
    }
  }

  Object.values(gameFinal).forEach(g => {
    if(!g.home || !g.away) return;
    T(g.home).pointsAllowed += (g.as||0); T(g.home).games++;
    T(g.away).pointsAllowed += (g.hs||0); T(g.away).games++;
  });

  return teams;
}

function computeRank(teams, getter, lowerIsBetter){
  const entries = Object.entries(teams)
    .map(([team,t]) => [team, getter(t)])
    .filter(([,v]) => v!=null && !isNaN(v));
  entries.sort((a,b) => lowerIsBetter ? a[1]-b[1] : b[1]-a[1]);
  const ranks = {};
  entries.forEach(([team],i) => ranks[team] = i+1);
  return ranks;
}

// Metrik-Konfiguration: 7 Blöcke, pro Metrik Getter + Formatierung + Rang-Richtung.
const TEAM_STATS_GROUPS = [
  { title:'Snaps / Volumen', items:[
    { label:'Total Defense Snaps', get:t=>t.snaps, low:false, fmt:v=>Math.round(v) },
    { label:'Snaps vs. Run', get:t=>t.snapsRun, low:false, fmt:v=>Math.round(v) },
    { label:'Snaps vs. Pass', get:t=>t.snapsPass, low:false, fmt:v=>Math.round(v) },
    { label:'Defensive Plays/Game', get:t=>t.games?t.snaps/t.games:null, low:false, fmt:v=>v.toFixed(1) },
  ]},
  { title:'Scoring & Yardage Allowed', items:[
    { label:'Points Allowed/Game', get:t=>t.games?t.pointsAllowed/t.games:null, low:true, fmt:v=>v.toFixed(1) },
    { label:'Yards Allowed/Game', get:t=>t.games?t.yards/t.games:null, low:true, fmt:v=>v.toFixed(1) },
    { label:'Yards Allowed/Play', get:t=>t.snaps?t.yards/t.snaps:null, low:true, fmt:v=>v.toFixed(2) },
    { label:'TDs Allowed', get:t=>t.tds, low:true, fmt:v=>Math.round(v) },
  ]},
  { title:'Run Defense', items:[
    { label:'Rush Yards Allowed/Game', get:t=>t.games?t.rushYards/t.games:null, low:true, fmt:v=>v.toFixed(1) },
    { label:'Rush Yards Allowed/Play', get:t=>t.rushPlays?t.rushYards/t.rushPlays:null, low:true, fmt:v=>v.toFixed(2) },
    { label:'Rush TDs Allowed', get:t=>t.rushTds, low:true, fmt:v=>Math.round(v) },
    { label:'Run Stop Rate', get:t=>t.rushPlays?t.stuffs/t.rushPlays*100:null, low:false, fmt:v=>v.toFixed(1)+'%' },
  ]},
  { title:'Pass Defense', items:[
    { label:'Pass Yards Allowed/Game', get:t=>t.games?t.passYards/t.games:null, low:true, fmt:v=>v.toFixed(1) },
    { label:'Pass Yards Allowed/Play', get:t=>t.passPlays?t.passYards/t.passPlays:null, low:true, fmt:v=>v.toFixed(2) },
    { label:'QB Hits', get:t=>t.qbHits, low:false, fmt:v=>Math.round(v) },
    { label:'Pass TDs Allowed', get:t=>t.passTds, low:true, fmt:v=>Math.round(v) },
  ]},
  { title:'Situational', items:[
    { label:'3rd Down Conv.% Allowed', get:t=>t.thirdAtt?t.thirdConv/t.thirdAtt*100:null, low:true, fmt:v=>v.toFixed(1)+'%' },
    { label:'4th Down Conv.% Allowed', get:t=>t.fourthAtt?t.fourthConv/t.fourthAtt*100:null, low:true, fmt:v=>v.toFixed(1)+'%' },
    { label:'Explosive Play Rate Allowed', get:t=>t.snaps?t.explosive/t.snaps*100:null, low:true, fmt:v=>v.toFixed(1)+'%' },
  ]},
  { title:'Advanced', items:[
    { label:'EPA Allowed/Play', get:t=>t.epaPlays?t.epaSum/t.epaPlays:null, low:true, fmt:v=>v.toFixed(3) },
    { label:'Success Rate Allowed', get:t=>t.successPlays?t.successSum/t.successPlays*100:null, low:true, fmt:v=>v.toFixed(1)+'%' },
    { label:'Havoc Rate', get:t=>t.snaps?(t.ff+t.ints+t.pbu+t.stuffs)/t.snaps*100:null, low:false, fmt:v=>v.toFixed(1)+'%' },
  ]},
  { title:'Takeaways', items:[
    { label:'Sacks', get:t=>t.sacks, low:false, fmt:v=>Math.round(v) },
    { label:'INTs', get:t=>t.ints, low:false, fmt:v=>Math.round(v) },
    { label:'Fumbles Forced', get:t=>t.ff, low:false, fmt:v=>Math.round(v) },
    { label:'Passes Defended (PBU)', get:t=>t.pbu, low:false, fmt:v=>Math.round(v) },
  ]},
  { title:'Discipline', items:[
    { label:'Penalties', get:t=>t.penalties, low:true, fmt:v=>Math.round(v) },
    { label:'Penalty Yards', get:t=>t.penaltyYards, low:true, fmt:v=>Math.round(v) },
  ]},
];

// Einklappen der KOMPLETTEN Team-Stats-Sektion (ein einzelner Toggle für den ganzen
// Bereich, nicht pro Kategorie) — einmalig gebunden, nicht bei jedem Render neu.
// Einklappen einer KOMPLETTEN Sektion (Depth Chart / Team Stats / Schedule &
// Standings / Team Roster) — ein einzelner Toggle für den ganzen Bereich inkl.
// aller Zwischenheader darin (z.B. Defense/Offense/Special Teams oder die 5
// Roster-Positionsspalten verschwinden mit, statt separat einklappbar zu bleiben).
// Einmalig gebunden (nicht bei jedem Render neu), einheitlich für alle vier Bereiche.
const sectionToggleBound = new Set();
function bindSectionToggle(hdrId, bodyId, chevronId){
  if(sectionToggleBound.has(hdrId)) return;
  sectionToggleBound.add(hdrId);
  const hdr = document.getElementById(hdrId);
  const body = document.getElementById(bodyId);
  const chevron = document.getElementById(chevronId);
  hdr.addEventListener('click', () => {
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : '';
    chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
  });
}
bindSectionToggle('dc-toggle-hdr', 'dc-body', 'dc-toggle-chevron');
bindSectionToggle('ts-toggle-hdr', 'ts-body', 'ts-toggle-chevron');
bindSectionToggle('sched-toggle-hdr', 'sched-body', 'sched-toggle-chevron');
bindSectionToggle('lineup-toggle-hdr', 'lineup-body', 'lineup-toggle-chevron');
bindSectionToggle('community-stats-toggle-hdr', 'community-stats-body', 'community-stats-toggle-chevron');
bindSectionToggle('roster-toggle-hdr', 'roster-body', 'roster-toggle-chevron');

// ── CACHE für die BERECHNETEN Aggregate (nicht die Roh-PBP) ──────────────────
// Sobald einmal berechnet, ändert sich eine ABGESCHLOSSENE Saison nie wieder —
// dauerhaft cachen. Die LAUFENDE Saison bekommt ein 6h-Fenster (wie beim Roster),
// da sich die Zahlen im Saisonverlauf noch ändern. Das eigentliche Tempo-Problem
// war NIE die Berechnung selbst, sondern das ~10-20MB-PBP-File jedes Mal neu zu
// laden und zu parsen — das entfällt jetzt komplett bei einem Cache-Treffer.
// ══════════════════════════════════════════════════════════════════════════
// DEFENSIVE LINEUP BREAKDOWN — nflverse participation-Daten (defense_players
// pro Snap), klassifiziert nach FRONT (DI/ED-Kombination), LB (Anzahl) und
// SECONDARY (CB/S-Kombination). Nur reguläre Saison (Woche 1-18), Playoffs
// bewusst ausgeschlossen, da nicht alle Teams gleich viele Playoff-Spiele
// haben — würde die Prozentwerte verzerren (siehe Chat).
// Verfügbar für alle unterstützten Saisons (MIN_YEAR bis heute) — siehe Chat:
// PFF-Positionszuordnung nutzt zwangsläufig das AKTUELLE PFF-Team-Roster, ältere
// Jahre sind dadurch tendenziell unvollständiger (nicht falscher) als aktuelle.
// Participation-Daten selbst kommen erst NACH Saisonende (inkl. Playoffs) von
// FTN Data — sind also für die laufende Saison nie aktuell, nur rückwirkend.
// ══════════════════════════════════════════════════════════════════════════

const LINEUP_MIN_YEAR = 2022; // deckt sich jetzt mit MIN_YEAR (Season-Dropdown) — siehe Chat zur PFF-Genauigkeits-Einschränkung bei älteren Jahren

// ── Exakte Zuordnungs-Tabellen (siehe Chat) — Lookup zuerst, generische Regeln
// (GOAL LINE / DB HEAVEN / LIGHT) erst danach als Auffangnetz.
const FRONT_LOOKUP = {
  '00':'SKINNY','01':'SKINNY','10':'SKINNY','11':'SKINNY','20':'SKINNY',
  '33':'X-TRA BIG',
  '30':'BIG',
  '03':'NASCAR','04':'NASCAR','05':'NASCAR', // "04" bewusst NASCAR, nicht GOAL LINE (siehe Chat-Klärung)
  '22':'4',
  '31':'31',
  '23':'43 UNDER/OVER',
  '13':'EDGE IN','02':'EDGE IN',
  '12':'3','32':'3','21':'3'
};
function classifyFront(di, ed){
  const key = `${di}${ed}`;
  if(FRONT_LOOKUP[key]) return FRONT_LOOKUP[key];
  if(di >= 4 || ed >= 4) return 'GOAL LINE';
  return 'SONSTIGE';
}
function classifyLB(lb){
  if(lb >= 5) return '5+'; // im Chat nicht explizit vergeben, Sammelkategorie
  return String(lb);
}
const SEC_LOOKUP = {
  '22':'BASE','32':'NICKEL','42':'DIME',
  '23':'BIG NICKEL','33':'BIG DIME','43':'DIME PLUS',
  '41':'SKINNY NICKEL','13':'SAFETY PLUS','31':'CB PLUS','24':'HUGE DIME'
};
function classifySecondary(cb, s){
  const key = `${cb}${s}`;
  if(SEC_LOOKUP[key]) return SEC_LOOKUP[key];
  const total = cb + s;
  if(total > 7) return 'DB HEAVEN';
  if(total < 4) return 'LIGHT';
  return 'XXX';
}

const FRONT_LABELS = [["max. 2 DL","SKINNY"],["3DI & 3ED","X-TRA BIG"],["3DI & 0ED","BIG"],["0DI / 3,4 or 5 ED","NASCAR"],
  ["2DI & 2ED","4"],["3 DI & 1 ED","31"],["2DI & 3ED (1 as SAM)","43 UNDER/OVER"],["1DI&3ED / 0DI&2ED","EDGE IN"],
  ["1DI&2ED / 3DI&2ED / 2DI&1ED","3"],["ab 4 DI / ab 4 ED","GOAL LINE"]];
const LB_LABELS = [["0 LB","0"],["1 LB","1"],["2 LB","2"],["3 LB","3"],["4 LB","4"],["5+ LB","5+"]];
const SEC_LABELS = [["2 CB / 2 S","BASE"],["3 CB / 2 S","NICKEL"],["4 CB / 2 S","DIME"],["2 CB / 3 S","BIG NICKEL"],
  ["3 CB / 3 S","BIG DIME"],["4 CB / 3 S","DIME PLUS"],["> 7 DBs","DB HEAVEN"],["< 4 DBs","LIGHT"],
  ["4 CB / 1 S","SKINNY NICKEL"],["1 CB / 3 S","SAFETY PLUS"],["3 CB / 1 S","CB PLUS"],["2 CB / 4 S","HUGE DIME"],["Sonstige Formation","XXX"]];

// v6: komplett neue Datenbasis (echte PFF-Positionen statt defense_positions,
// strikter play_type-Filter statt defenders_in_box-Näherung) — alte Caches
// enthalten die vorherige, ungenaue Auswertung und müssen verworfen werden.
function luCacheKey(year){ return `mim_lineup_v7_${year}`; }
function loadLineupCache(year){
  try{
    const raw = localStorage.getItem(luCacheKey(year));
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.teams;
  }catch(e){ return null; }
}
// Alte, obsolete Lineup-Cache-Versionen (v1-v5) entfernen — verhindert, dass sie
// unnötig Platz belegen und den v6-Cache am Speichern hindern (siehe Chat: exakt
// dasselbe localStorage-Voll-Problem wie an anderer Stelle im Projekt bekannt).
function cleanupOldLineupCaches(){
  try{
    const keysToRemove = [];
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if(k && /^mim_lineup_v[1-6]_/.test(k)) keysToRemove.push(k);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    if(keysToRemove.length) console.log(`[Lineup] ${keysToRemove.length} alte Cache-Version(en) aufgeräumt.`);
    return keysToRemove.length;
  }catch(e){ return 0; }
}

// Der Lineup-Cache selbst ist winzig (siehe Chat: 13,4 KB) — wenn das Speichern
// trotzdem an "quota exceeded" scheitert, ist der GESAMTE localStorage der Seite
// voll (bestätigt durch dieselbe Fehlermeldung beim Roster-Cache). Also müssen wir
// hier auch fremde, aber unkritische Caches opfern — die regenerieren sich bei
// Bedarf einfach neu. Stufenweise, um nicht mehr wegzuwerfen als nötig.
function cleanupUnrelatedCachesForSpace(keepAbbr, keepYear){
  try{
    const keysToRemove = [];
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if(!k) continue;
      // Roster-Caches ANDERER Teams (aktuelles Team behalten, falls schon geladen)
      if(/^mim_roster_v\d+_/.test(k) && !k.includes(`_${keepAbbr}_`)) keysToRemove.push(k);
      // Team-Stats-Caches ANDERER Jahre
      if(/^mim_teamstats_v\d+_/.test(k) && !k.endsWith(`_${keepYear}`)) keysToRemove.push(k);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    if(keysToRemove.length) console.log(`[Lineup] ${keysToRemove.length} fremde Cache-Eintr(ä)ge (Roster/Team-Stats anderer Teams/Jahre) aufgeräumt, um Platz zu schaffen.`);
    return keysToRemove.length;
  }catch(e){ return 0; }
}

function saveLineupCacheLocal(year, teamsObj, abbr){
  const payload = JSON.stringify({ ts: Date.now(), teams: teamsObj });
  console.log(`[Lineup] Cache-Payload für ${year}: ${(payload.length/1024).toFixed(1)} KB`);
  try{
    localStorage.setItem(luCacheKey(year), payload);
    return;
  }catch(e){
    console.warn('[Lineup] Speichern fehlgeschlagen (evtl. Speicher voll), räume alte Lineup-Caches auf und versuche erneut:', e.message);
  }
  cleanupOldLineupCaches();
  try{
    localStorage.setItem(luCacheKey(year), payload);
    return;
  }catch(e2){
    console.warn('[Lineup] Immer noch voll — Payload selbst ist klein (siehe KB oben), also liegt es am GESAMTEN Speicher. Räume jetzt auch fremde Caches (Roster/Team-Stats anderer Teams/Jahre) auf:', e2.message);
  }
  cleanupUnrelatedCachesForSpace(abbr||'', year);
  try{
    localStorage.setItem(luCacheKey(year), payload);
  }catch(e3){
    console.warn('[Lineup] Auch nach vollständigem Aufräumen konnte der Cache nicht gespeichert werden — Lineup-Daten werden bei jedem Laden neu berechnet:', e3.message);
  }
}

function saveLineupCache(year, teamsObj, abbr){
  saveLineupCacheLocal(year, teamsObj, abbr);
  // GETEILT (Firestore): deckt alle 32 Teams auf einmal ab — der nächste Besucher,
  // der IRGENDEIN Team für diese Saison ansieht, bekommt es sofort (siehe Chat).
  saveSharedCache(`lineup_${year}`, { teams: teamsObj })
    .then(ok => { if(ok) console.log(`[Lineup] Geteilter Cache (Firestore) für ${year} geschrieben.`); });
}

function normalizeGameKey(season, week, away, home){
  return `${season}_${String(week).padStart(2,'0')}_${away}_${home}`;
}

// Fallback-Zuordnung NUR für Lineup Details — bewusst eigene Version statt der
// bestehenden classifyIdpGroup, da OLB hier zu ED zählen soll (nicht zu LB wie
// beim Team Roster), siehe Chat.
function classifyLineupFallback(dcp, pos){
  const t = (dcp || pos || '').toUpperCase();
  if(['DT','NT','DL'].includes(t)) return 'DI';
  if(['DE','EDGE','OLB'].includes(t)) return 'ED'; // OLB zählt hier bewusst zu ED
  if(['LB','ILB','MLB'].includes(t)) return 'LB';
  if(t === 'CB') return 'CB';
  if(['S','FS','SS','DB'].includes(t)) return 'S';
  return null;
}

// gsis_id -> echte PFF-Position (DI/ED/LB/CB/S), über ALLE 32 Teams — nutzt
// dieselbe PFF_TEAM_ID/PFF_POS_MAP/fetchViaWorker-Infrastruktur wie Team Roster.
// Kann PFF für einen Spieler nichts liefern (z.B. bei älteren Saisons, wenn der
// Spieler heute nicht mehr aktiv/beim selben Team ist), fällt es auf die
// depth_chart_position/position aus der jeweiligen Saison-Rosters-CSV zurück.
async function buildGsisToBucketMapForSeason(year, onProgress){
  onProgress && onProgress(2, 'Lade Rosters-CSV…');
  const gsisToPffId = new Map();
  const gsisToFallback = new Map();
  const rosterText = await fetchNflverseCSV(NV_ROSTER_URL(year));
  if(rosterText){
    const lines = rosterText.split('\n').filter(l => l.trim());
    const H = splitCSV(lines[0]).map(h => h.trim().toLowerCase());
    const iGs = H.indexOf('gsis_id'), iPf = H.indexOf('pff_id'),
          iDcp = H.indexOf('depth_chart_position'), iPos = H.indexOf('position');
    if(iGs >= 0){
      for(let i=1;i<lines.length;i++){
        const row = splitCSV(lines[i]);
        const gid = (row[iGs]||'').trim();
        if(!gid) continue;
        if(iPf >= 0){
          const pid = (row[iPf]||'').trim();
          if(pid && pid !== 'NA') gsisToPffId.set(gid, pid);
        }
        const fallbackBucket = classifyLineupFallback(iDcp>=0?row[iDcp]:'', iPos>=0?row[iPos]:'');
        if(fallbackBucket) gsisToFallback.set(gid, fallbackBucket);
      }
    }
  } else {
    console.warn(`[Lineup] Rosters-CSV ${year} konnte nicht geladen werden.`);
  }
  onProgress && onProgress(8, 'Lade PFF-Team-Rosters (0/32)…');

  const pffIdToBucket = new Map();
  const uniqueTeamIds = [...new Set(Object.values(PFF_TEAM_ID))];
  let done = 0;
  for(const teamId of uniqueTeamIds){
    try{
      const res = await fetchViaWorker(`https://www.pff.com/api/teams/${teamId}/roster`);
      if(res){
        const json = JSON.parse(res);
        (json.team_players || []).forEach(pl => {
          if(pl.id && pl.position){
            const bucket = PFF_POS_MAP[pl.position.toUpperCase()];
            if(bucket) pffIdToBucket.set(String(pl.id), bucket);
          }
        });
      }
    }catch(e){ console.warn('[Lineup] PFF-Roster Fehler für Team', teamId, e); }
    done++;
    onProgress && onProgress(8 + Math.round(done/uniqueTeamIds.length*42), `Lade PFF-Team-Rosters (${done}/${uniqueTeamIds.length})…`);
  }

  const gsisToBucket = new Map();
  gsisToPffId.forEach((pid, gid) => {
    const bucket = pffIdToBucket.get(pid);
    if(bucket) gsisToBucket.set(gid, bucket);
  });
  let fallbackUsed = 0;
  gsisToFallback.forEach((bucket, gid) => {
    if(!gsisToBucket.has(gid)){ gsisToBucket.set(gid, bucket); fallbackUsed++; }
  });
  if(fallbackUsed) console.log(`[Lineup] ${fallbackUsed} Spieler über nflverse depth_chart_position/position statt PFF zugeordnet (Fallback für ${year}).`);
  return gsisToBucket;
}

// Menge "echter" Snaps (play_type exakt 'run'/'pass') aus der vollen PBP-Datei —
// schließt no_play/Pre-Snap-Penalties, qb_kneel, qb_spike aus (siehe Chat).
async function buildValidSnapKeysForSeason(year, onProgress){
  onProgress && onProgress(52, 'Lade Play-by-Play-Daten…');
  const url = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${year}.csv`;
  const text = await fetchNflverseCSV(url);
  if(!text){
    console.warn('[Lineup] PBP-CSV konnte nicht geladen werden — Special-Teams/No-Play-Filter fällt auf Formation-Näherung zurück.');
    return null;
  }
  onProgress && onProgress(65, 'Werte Play-by-Play-Daten aus…');
  const lines = text.split('\n');
  const H = splitCSV(lines[0]);
  const iSeason=H.indexOf('season'), iWeek=H.indexOf('week'), iAway=H.indexOf('away_team'),
        iHome=H.indexOf('home_team'), iPlayId=H.indexOf('play_id'), iPlayType=H.indexOf('play_type');
  if(iSeason<0||iWeek<0||iAway<0||iHome<0||iPlayId<0||iPlayType<0){
    console.warn('[Lineup] Erwartete Spalten in PBP-CSV nicht gefunden.');
    return null;
  }
  const validKeys = new Set();
  for(let i=1;i<lines.length;i++){
    if(!lines[i].trim()) continue;
    const row = splitCSV(lines[i]);
    const pt = row[iPlayType];
    if(pt !== 'run' && pt !== 'pass') continue;
    validKeys.add(normalizeGameKey(row[iSeason], row[iWeek], row[iAway], row[iHome]) + '|' + row[iPlayId]);
  }
  return validKeys;
}

async function computeLineupDataForSeason(year, onProgress){
  const [gsisToBucket, validSnapKeys] = await Promise.all([
    buildGsisToBucketMapForSeason(year, onProgress),
    buildValidSnapKeysForSeason(year, onProgress)
  ]);

  onProgress && onProgress(75, 'Lade participation-Daten…');
  const url = `https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_${year}.csv`;
  const text = await fetchNflverseCSV(url);
  if(!text) return null; // z.B. laufende Saison, noch keine Daten von FTN

  onProgress && onProgress(85, 'Werte Lineups aus…');
  const lines = text.split('\n');
  const H = splitCSV(lines[0]);
  const iGameId = H.indexOf('nflverse_game_id'), iPlayId = H.indexOf('play_id'),
        iPoss = H.indexOf('possession_team'), iDefPlayers = H.indexOf('defense_players'),
        iOffForm = H.indexOf('offense_formation');
  if(iGameId < 0 || iPoss < 0 || iDefPlayers < 0){
    console.warn('[Lineup] Erwartete Spalten in participation-CSV nicht gefunden. Header war:', H.join(', '));
    return null;
  }

  const teams = {}; // abbr -> {front:{}, lb:{}, secondary:{}, codes:{}, total}
  const ensureTeam = abbr => teams[abbr] || (teams[abbr] = { front:{}, lb:{}, secondary:{}, codes:{}, total:0 });

  for(let i=1;i<lines.length;i++){
    if(!lines[i].trim()) continue;
    const row = splitCSV(lines[i]);

    const gameId = row[iGameId];
    const parts = gameId.split('_'); // season_week_away_home
    if(parts.length < 4) continue;
    const week = parseInt(parts[1], 10);
    if(!week || week > 18) continue; // Woche 1-18 = reguläre Saison, Playoffs raus

    const away = parts[2], home = parts[3];

    if(validSnapKeys){
      const key = normalizeGameKey(parts[0], parts[1], away, home) + '|' + row[iPlayId];
      if(!validSnapKeys.has(key)) continue;
    } else if(iOffForm >= 0){
      const fv = row[iOffForm];
      if(!fv || fv === 'NA') continue;
    }

    const poss = row[iPoss];
    const defTeam = (poss === away) ? home : (poss === home ? away : null);
    if(!defTeam) continue;

    const defRaw = row[iDefPlayers];
    if(!defRaw) continue;
    const ids = defRaw.split(';').map(s => s.trim()).filter(Boolean);

    let di=0, ed=0, lb=0, cb=0, s=0;
    ids.forEach(gid => {
      const bucket = gsisToBucket.get(gid);
      if(bucket==='DI') di++; else if(bucket==='ED') ed++; else if(bucket==='LB') lb++;
      else if(bucket==='CB') cb++; else if(bucket==='S') s++;
    });

    const t = ensureTeam(defTeam);
    const frontLabel = classifyFront(di, ed), lbLabel = classifyLB(lb), secLabel = classifySecondary(cb, s);
    t.front[frontLabel] = (t.front[frontLabel]||0) + 1;
    t.lb[lbLabel] = (t.lb[lbLabel]||0) + 1;
    t.secondary[secLabel] = (t.secondary[secLabel]||0) + 1;
    const fullCode = `${di}${ed}${lb}${cb}${s}`;
    t.codes[fullCode] = (t.codes[fullCode]||0) + 1;
    t.total++;

    if(i % 8000 === 0) onProgress && onProgress(85 + Math.round(i/lines.length*13), 'Werte Lineups aus…');
  }
  // "codes" auf die Top 15 je Team kürzen — mehr brauchen wir nirgends (Most Used
  // Schemes zeigt nur Top 3), aber ungekürzt kann das bei 32 Teams mehrere hundert
  // KB im Cache belegen und so das Speichern selbst verhindern (siehe Chat).
  Object.keys(teams).forEach(abbr => {
    const t = teams[abbr];
    t.codes = Object.fromEntries(
      Object.entries(t.codes).sort((a,b) => b[1]-a[1]).slice(0, 15)
    );
  });

  onProgress && onProgress(100, 'Fertig.');
  return teams;
}

// Für PFF (Team-Roster-API) — serverseitig ebenfalls direkter Fetch zuerst,
// Worker nur als Rückfallebene (PFF hat teils Bot-Schutz, der IP-abhängig sein
// kann — falls direkt blockiert wird, greift der bewährte Worker-Umweg).
async function fetchViaWorker(url){
  const attempts = [url, `${MIM_WORKER}${encodeURIComponent(url)}`];
  for(const a of attempts){
    try{
      const r = await fetch(a);
      if(!r.ok) continue;
      return await r.text();
    }catch(e){}
  }
  return null;
}

// ─── HAUPTABLAUF ─────────────────────────────────────────────────────────────
async function main(){
  const yearArg = process.argv[2];
  const year = yearArg ? parseInt(yearArg, 10) : CURRENT_SEASON_YEAR;
  console.log(`\n═══ Precompute für Saison ${year} ═══\n`);

  // 1) TEAM STATS (alle 32 Teams, ein PBP-Fetch deckt automatisch alle ab)
  console.log('[TeamStats] Lade Play-by-Play-Daten…');
  const pbpText = await fetchPbpCsv(year);
  if(pbpText){
    console.log('[TeamStats] Berechne Team-Defense-Stats für alle 32 Teams…');
    const teamStats = aggregateTeamDefense(pbpText);
    await saveSharedCache(`teamstats_${year}`, { teams: teamStats });
    console.log(`[TeamStats] ✅ Geschrieben nach shared_cache/teamstats_${year}`);
  } else {
    console.log(`[TeamStats] ⚠️  Keine Play-by-Play-Daten für ${year} verfügbar (evtl. Saison noch nicht gestartet) — übersprungen.`);
  }

  // 2) LINEUP DETAILS (FRONT/LB/SECONDARY, alle 32 Teams)
  if(year >= LINEUP_MIN_YEAR){
    console.log('\n[Lineup] Berechne Lineup Details für alle 32 Teams (kann mehrere Minuten dauern)…');
    const onProgress = (pct, label) => process.stdout.write(`\r[Lineup] ${pct}% — ${label}                    `);
    const lineupTeams = await computeLineupDataForSeason(year, onProgress);
    console.log(''); // Zeilenumbruch nach der Fortschrittsanzeige
    if(lineupTeams){
      // Codes auf Top 15 kürzen (wie im Browser) — hält den Firestore-Eintrag klein.
      Object.keys(lineupTeams).forEach(abbr => {
        const t = lineupTeams[abbr];
        t.codes = Object.fromEntries(Object.entries(t.codes).sort((a,b) => b[1]-a[1]).slice(0, 15));
      });
      await saveSharedCache(`lineup_${year}`, { teams: lineupTeams });
      console.log(`[Lineup] ✅ Geschrieben nach shared_cache/lineup_${year}`);
    } else {
      console.log(`[Lineup] ⚠️  Keine participation-Daten für ${year} verfügbar (werden erst nach Saisonende inkl. Playoffs von FTN bereitgestellt) — übersprungen.`);
    }
  } else {
    console.log(`[Lineup] Jahr ${year} liegt vor LINEUP_MIN_YEAR (${LINEUP_MIN_YEAR}) — übersprungen.`);
  }

  console.log('\n═══ Fertig ═══\n');
  process.exit(0);
}

main().catch(e => {
  console.error('FEHLER im Precompute-Lauf:', e);
  process.exit(1);
});
