// scrape-formations.js — Holt für jedes NFL-Team die ECHTEN Base/Nickel/Dime-
// Personnel-Pakete von TWO·DEEP (mit deren ausdrücklicher Erlaubnis für dieses
// Projekt, siehe Chat). Läuft per GitHub Actions regelmäßig (siehe zugehörige
// .yml-Datei) und schreibt das Ergebnis als formations.json ins Repo — team.html
// liest dann nur noch diese fertige Datei, kein Live-Scraping mehr nötig.
//
// WICHTIG: Dieses Skript wurde NICHT live gegen thetwodeep.com getestet (die
// Sandbox, in der es geschrieben wurde, hat keinen Netzwerkzugriff auf die
// Seite). Die Selektoren (.td-fnode-role, .td-fnode-jersey, a[href*="pside=def"])
// sind aus einem echten, live abgerufenen HTML-Dump bestätigt (siehe Chat) —
// der Klick-Mechanismus für die Base/Nickel/Dime-Buttons ist dagegen eine
// robuste, aber ungetestete Annahme (Text-Suche über alle klickbaren
// Elemente). Beim ERSTEN echten Lauf unbedingt die Konsolen-Ausgabe genau
// prüfen — das Skript loggt bei jedem Schritt, was es tut/findet.

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Dieselbe Team-Kürzel-Tabelle wie in team.html (ESPN_A) — TWO·DEEP nutzt
// dieselben Standard-Kürzel in ihren URLs.
const TEAM_SLUG = {
  ARI:'ari', ATL:'atl', BAL:'bal', BUF:'buf', CAR:'car', CHI:'chi', CIN:'cin',
  CLE:'cle', DAL:'dal', DEN:'den', DET:'det', GB:'gb', HOU:'hou', IND:'ind',
  JAX:'jax', KC:'kc', LAC:'lac', LAR:'lar', LV:'lv', MIA:'mia', MIN:'min',
  NE:'ne', NO:'no', NYG:'nyg', NYJ:'nyj', PHI:'phi', PIT:'pit', SF:'sf',
  SEA:'sea', TB:'tb', TEN:'ten', WAS:'wsh',
};

const PACKAGES = ['Base', 'Nickel', 'Dime'];
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'formations.json'); // precompute-setup/scripts/ -> Repo-Root
const DELAY_BETWEEN_TEAMS_MS = 3000; // Höflichkeitspause, keine 32 Requests im Sekundentakt

function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

// Sucht unter ALLEN klickbaren/text-tragenden Elementen eines, dessen
// GESAMTER (getrimmter) Text exakt dem Label entspricht UND das selbst keine
// Kind-Elemente hat (verhindert, dass wir einen großen Wrapper treffen, der
// zufällig auch "Base" im Text enthält, z.B. weil er mehrere Buttons umschließt).
async function clickPackageButton(page, label){
  const clicked = await page.evaluate((lbl) => {
    const candidates = [...document.querySelectorAll('button, [role="button"], a, span, div')];
    const match = candidates.find(el => el.children.length === 0 && el.textContent.trim() === lbl);
    if(match){
      match.click();
      return true;
    }
    return false;
  }, label);
  if(!clicked){
    console.warn(`  [WARNUNG] Button "${label}" nicht gefunden — evtl. Selektor/Text hat sich geändert.`);
    return false;
  }
  // Kurze Pause, damit React die Personnel-Ansicht neu rendert, bevor wir auslesen.
  await sleep(700);
  return true;
}

// Liest die aktuell angezeigte Defense-Formation aus dem DOM. Nutzt die live
// bestätigten Klassennamen (siehe Chat) — direkte DOM-Abfrage statt Regex auf
// rohem HTML, deshalb robust gegenüber Whitespace/Attribut-Reihenfolge.
async function extractDefense(page){
  return await page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="pside=def"]')];
    const seen = new Set();
    const players = [];
    for(const a of anchors){
      const href = a.getAttribute('href') || '';
      const slugMatch = href.match(/player=([a-z0-9-]+)/);
      if(!slugMatch) continue;
      const slug = slugMatch[1];
      if(seen.has(slug)) continue;
      const roleEl = a.querySelector('.td-fnode-role');
      if(!roleEl) continue; // zweiter Link desselben Spielers (nur Name, kein Rollen-Badge) — überspringen
      seen.add(slug);
      const jerseyEl = a.querySelector('.td-fnode-jersey');
      players.push({
        slug,
        posLabel: roleEl.textContent.trim(),
        jersey: jerseyEl ? jerseyEl.textContent.trim() : null,
      });
    }
    return players;
  });
}

async function scrapeTeam(browser, abbr, slug){
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  const url = `https://www.thetwodeep.com/nfl/${slug}/formation`;
  console.log(`\n[${abbr}] Lade ${url} ...`);

  const result = { base: null, nickel: null, dime: null };

  try{
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    // Warten, bis mindestens ein Spieler-Knoten gerendert ist, bevor wir irgendwas anfassen.
    await page.waitForSelector('a[href*="pside=def"] .td-fnode-role', { timeout: 15000 }).catch(() => {
      console.warn(`  [${abbr}] Kein ".td-fnode-role"-Element nach 15s gefunden — Seite evtl. anders aufgebaut oder nicht geladen.`);
    });

    for(const pkg of PACKAGES){
      console.log(`  [${abbr}] Versuche Paket "${pkg}" anzuklicken...`);
      const ok = await clickPackageButton(page, pkg);
      if(!ok){
        console.warn(`  [${abbr}] Paket "${pkg}" übersprungen (Button nicht gefunden).`);
        continue;
      }
      const players = await extractDefense(page);
      console.log(`  [${abbr}] Paket "${pkg}": ${players.length} Def-Spieler erkannt — ${players.map(p => `${p.posLabel}:${p.slug}`).join(', ')}`);
      result[pkg.toLowerCase()] = players.length ? players : null;
    }
  }catch(e){
    console.error(`  [${abbr}] FEHLER beim Laden/Verarbeiten:`, e.message);
  }finally{
    await page.close();
  }

  return result;
}

async function main(){
  console.log(`Starte Formation-Scrape für ${Object.keys(TEAM_SLUG).length} Teams...`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // nötig für die meisten CI-Runner (auch GitHub Actions)
  });

  const output = { updatedAt: new Date().toISOString(), teams: {} };

  for(const [abbr, slug] of Object.entries(TEAM_SLUG)){
    output.teams[abbr] = await scrapeTeam(browser, abbr, slug);
    await sleep(DELAY_BETWEEN_TEAMS_MS);
  }

  await browser.close();

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nFertig. Ergebnis geschrieben nach: ${OUTPUT_PATH}`);

  // Kurze Zusammenfassung, wie viele Teams pro Paket erfolgreich waren —
  // damit im Actions-Log auf einen Blick sichtbar ist, ob was systematisch fehlschlägt.
  const counts = { base: 0, nickel: 0, dime: 0 };
  Object.values(output.teams).forEach(t => {
    if(t.base) counts.base++;
    if(t.nickel) counts.nickel++;
    if(t.dime) counts.dime++;
  });
  console.log(`Zusammenfassung: Base ${counts.base}/32, Nickel ${counts.nickel}/32, Dime ${counts.dime}/32 Teams erfolgreich.`);
}

main().catch(e => {
  console.error('Unerwarteter Fehler im Scraper:', e);
  process.exit(1);
});
