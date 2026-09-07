#!/usr/bin/env node
// Genereerib tunniplaani HTML-i otse EduPage'ist, ilma aSc XML-failita.
//
// Kasutus:
//   node edupage-generate.mjs viru
//   node edupage-generate.mjs kivioli-tee-25
//   node edupage-generate.mjs koik
//
// Loeb EduPage'i avalikku JSON-liidest, teisendab andmed samasse kujju,
// mida tunniplaan.html juba kasutab, ja kutsub valja selle enda
// HTML-i genereerimise funktsioonid. Renderdust siin ei dubleerita.
//
// Iga klassi, opetaja ja ruumi leht kannab mitut nadalat (jooksev pluss
// jargmised), mille vahel saab lehel liikuda. Iga nadal renderdatakse
// sel nadalal kehtiva tunniplaaniga ja selle nadala asendustega.

import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laeAsendused, SYNDMUSTE_SEKTSIOON } from './edupage-asendused.mjs';
import { edupagePost } from './edupage-fetch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const KOOLID = {
  'viru': {
    host: 'kivioli1keskkool.edupage.org',
    nimi: 'Kiviõli Riigikool, Viru õppekoht',
    valjund: 'dist/viru',
  },
  'kivioli-tee-25': {
    // NB! Uks taht erineb esimesest: kiviol1, mitte kivioli1.
    host: 'kiviol1keskkool.edupage.org',
    nimi: 'Kiviõli Riigikool, Kiviõli tee 25 õppekoht',
    valjund: 'dist/kivioli-tee-25',
  },
};

// Juhendatud tunni pikkus minutites, arvutatuna sloti algusest.
// 0 tahendab: naita aSc aegu muutmata. Vana 45-minutilise plaani
// demoks: TUND=0 TOPELT=0 node edupage-generate.mjs ...
const SINGLE_MIN = process.env.TUND !== undefined ? Number(process.env.TUND) : 40;
const DOUBLE_MIN = process.env.TOPELT !== undefined ? Number(process.env.TOPELT) : 75;

// Mitu nadalat leht kannab: jooksev pluss jargmised. Kolm nadalat katab
// kaks nadalat ette, sest osa asendusi on teada nadal ette.
const NADALAID = 3;

// Asenduste loetelu pakitakse kokku, kui ridu on rohkem kui nii palju:
// esimesed jaavad nahtavale, ulejaanud avanevad "+ veel N" alt.
const KOKKU_ALATES = 7;

// Mitu paeva ette syndmusi avalehel loetletakse.
const ETTEVAATE_PAEVI = 14;

// Mitu paeva EduPage'ilt korraga kusitakse. Iga paev on eraldi POST.
const KORRAGA = 4;

const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------
// EduPage
// ---------------------------------------------------------------

// Paringu tegemine, koos korduskatsetega, elab edupage-fetch.mjs-is.
const edupage = edupagePost;

// Koik oppeaasta tunniplaanid, kehtivuse alguse jarjekorras. NB! EduPage
// ei tagasta neid kuupaeva jarjekorras, seega massiivi viimane element
// ei ole uusim.
async function laeTunniplaanid(host) {
  const aasta = new Date().getMonth() >= 7
    ? new Date().getFullYear()
    : new Date().getFullYear() - 1;

  const d = await edupage(host, '/timetable/server/ttviewer.js?__func=getTTViewerData', [null, aasta]);
  const list = d?.r?.regular?.timetables || [];
  if (!list.length) throw new Error(`${host}: tunniplaane ei leitud`);

  return [...list].sort((a, b) => a.datefrom.localeCompare(b.datefrom));
}

// Nadalal kehtib see plaan, mille algus on hiljemalt nadala reedel,
// ja neist uusim. Kui ukski nii vara ei alga, votame varaseima: parem
// mingi plaan kui tuhi leht.
function valiTunniplaan(tunniplaanid, nadal) {
  const reede = nadal.paevad[4];
  const sobivad = tunniplaanid.filter(t => t.datefrom <= reede);
  return sobivad.length ? sobivad[sobivad.length - 1] : tunniplaanid[0];
}

async function laeAndmed(host, ttNum) {
  const d = await edupage(host, '/timetable/server/regulartt.js?__func=regularttGetData', [null, String(ttNum)]);
  const tables = d?.r?.dbiAccessorRes?.tables;
  if (!tables) throw new Error(`${host}: tunniplaani ${ttNum} andmeid ei saanud`);
  return Object.fromEntries(tables.map(t => [t.id, t.data_rows || []]));
}

// ---------------------------------------------------------------
// EduPage -> sama DB kuju, mille parseXML tunniplaan.html-is toodab
// ---------------------------------------------------------------

function teisendaDB(T, DB) {
  DB.periods = T.periods
    .map(p => ({
      period: parseInt(p.period, 10),
      name: p.name,
      short: p.short,
      starttime: p.starttime,
      endtime: p.endtime,
    }))
    .sort((a, b) => a.period - b.period);

  DB.breaks = (T.breaks || []).map(b => ({
    name: b.name,
    short: b.short,
    break: parseInt(b.break, 10),
    starttime: b.starttime,
    endtime: b.endtime,
  }));

  DB.subjects = {};
  for (const s of T.subjects) DB.subjects[s.id] = { id: s.id, name: s.name, short: s.short };

  // EduPage annab opetaja nime kujul "PEREKONNANIMI Eesnimi" (name_format LSF).
  DB.teachers = {};
  for (const t of T.teachers) {
    const osad = String(t.name || '').trim().split(/\s+/);
    const lastname = osad.shift() || '';
    const firstname = osad.join(' ');
    DB.teachers[t.id] = {
      id: t.id, firstname, lastname,
      name: t.name || t.short || '',
      short: t.short || '',
      color: t.color || '',
    };
  }

  DB.classes = {};
  for (const c of T.classes) {
    DB.classes[c.id] = {
      id: c.id, name: c.name, short: c.short,
      teacherid: c.teacherid || '',
    };
  }

  DB.classrooms = {};
  for (const r of T.classrooms) DB.classrooms[r.id] = { id: r.id, name: r.name, short: r.short };

  DB.groups = {};
  for (const g of T.groups) {
    DB.groups[g.id] = {
      id: g.id, name: g.name, classid: g.classid,
      entireclass: g.entireclass === true || g.entireclass === '1',
    };
  }

  DB.lessons = {};
  for (const l of T.lessons) {
    DB.lessons[l.id] = {
      id: l.id,
      subjectid: l.subjectid || '',
      classids: l.classids || [],
      teacherids: l.teacherids || [],
      classroomids: l.classroomids || [],
      groupids: l.groupids || [],
      periodspercard: parseInt(l.durationperiods || 1, 10),
    };
  }

  DB.cards = T.cards.map(c => ({
    lessonid: c.lessonid,
    period: parseInt(c.period, 10),
    days: c.days,
    classroomids: c.classroomids || [],
  }));
}

// ---------------------------------------------------------------
// Laenab tunniplaan.html-i enda renderdusfunktsioonid
// ---------------------------------------------------------------

function laeRenderdaja() {
  const html = readFileSync(join(HERE, 'tunniplaan.html'), 'utf8');
  const algus = html.indexOf('<script>\n');
  const lopp = html.lastIndexOf('\n</script>');
  if (algus < 0 || lopp < 0) throw new Error('tunniplaan.html: skriptiplokki ei leitud');
  const src = html.slice(algus + '<script>\n'.length, lopp);

  const noop = () => {};
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ style: {}, classList: { add: noop }, appendChild: noop }),
  };

  const tehas = new Function('document', 'window', 'alert', 'console', `
    ${src}
    return {
      DB, buildIndexPage, buildTimetableTitle, buildTimetableTable, wrapInHtmlPage,
      uniqueSlugs, getExportCss, guessPeriodPairs,
      seaUksik:  v => { SINGLE_LESSON_MINUTES = v; },
      seaTopelt: v => { DOUBLE_LESSON_MINUTES = v; },
      seaAsendused: v => { SUBST_CELLS = v; },
      seaNadal: v => { WEEK_DAYS = v; },
    };
  `);

  return tehas(doc, { print: noop }, noop, console);
}

// Uks renderdaja iga tunniplaani kohta: DB on renderdaja globaal, seega
// ei saa kaht plaani samas eksemplaris hoida.
async function laeRenderdajaPlaanile(host, tp) {
  const T = await laeAndmed(host, tp.tt_num);
  const R = laeRenderdaja();
  teisendaDB(T, R.DB);
  // Paarid tuleb tunniplaan.html-i enda loogikast, mitte siit uuesti
  // kirjutatuna - muidu lahevad vidin ja genereeritud leht lahku.
  R.guessPeriodPairs();
  R.seaUksik(SINGLE_MIN);
  R.seaTopelt(DOUBLE_MIN);
  R.T = T;
  return R;
}

// ---------------------------------------------------------------
// Kehtivus
// ---------------------------------------------------------------

// aSc paneb kehtivusperioodi globals-i tekstiväljale kujul
// "Kehtivus: 23/05/2026-09/06/2026". Tagastab lõppkuupäeva ISO kujul.
function kehtivuseLopp(T) {
  const tekst = T.globals?.[0]?.settings?.m_strDateBellowTimeTable || '';
  const m = tekst.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[6]}-${m[5]}-${m[4]}` : null;
}

// Genereerimise aeg Eesti ajas. Masin voib joosta UTC peal,
// aga lugeja loeb kellaaega kohalikus ajas.
function uuendatud() {
  return new Date().toLocaleString('et-EE', {
    timeZone: 'Europe/Tallinn',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Riba index.html-i ulaossa: milline plaan, mis ajaga ja millal tehtud.
// Ilma selleta ei saa vastuvotja aru, et tegu on hetketombega, mitte live-vaatega.
function paiseRiba(kool, tp, lopp, kuupaev, viimanePaev, aegunud) {
  const hoiatus = aegunud
    ? `<div class="subst-box"><h3>Tähelepanu</h3>` +
      `<p style="margin:0">See tunniplaan kehtis kuni <strong>${esc(lopp)}</strong> ja on aegunud. ` +
      `Kool ei ole veel uut plaani avaldanud.</p></div>`
    : '';
  return hoiatus +
    `<p style="color:#666; font-size:0.85rem; margin:0 0 1rem 0">` +
    `${esc(kool.nimi)}<br>` +
    `Tunniplaan: ${esc(tp.text)}${lopp ? `, kehtiv kuni ${esc(lopp)}` : ''}<br>` +
    `Asendused ja sündmused ${esc(kuupaev)} kuni ${esc(viimanePaev)}. ` +
    `Leht uuendatud ${esc(uuendatud())}.` +
    `</p>`;
}

// ---------------------------------------------------------------
// Kuupaevad ja nadalad
// ---------------------------------------------------------------

const NADALAPAEV = ['E', 'T', 'K', 'N', 'R'];
const KUUD = ['jaanuar', 'veebruar', 'märts', 'aprill', 'mai', 'juuni',
  'juuli', 'august', 'september', 'oktoober', 'november', 'detsember'];

// Esmaspaev = 0, ... reede = 4. Nadalavahetus tagastab null.
function nadalapaevaIndeks(kuupaev) {
  const d = new Date(kuupaev + 'T12:00:00Z').getUTCDay();
  return d >= 1 && d <= 5 ? d - 1 : null;
}

function lisaPaevi(kuupaev, n) {
  const d = new Date(kuupaev + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "2026-09-02" -> "K 02.09"
function lyhiKuupaev(kuupaev) {
  const [, kuu, paev] = kuupaev.split('-');
  const n = nadalapaevaIndeks(kuupaev);
  return `${n !== null ? NADALAPAEV[n] + ' ' : ''}${paev}.${kuu}`;
}

// Jooksva nadala esmaspaev. Nadalavahetusel on jooksev nadal labi ja
// jooksvaks loeme jargmist: laupaeval tahab lugeja naha esmaspaeva.
function jooksevEsmaspaev(kuupaev) {
  const d = new Date(kuupaev + 'T12:00:00Z').getUTCDay(); // 0 = puhapaev
  const nihe = d === 0 ? 1 : d === 6 ? 2 : 1 - d;
  return lisaPaevi(kuupaev, nihe);
}

// "7.–11. september" voi "28. september – 2. oktoober"
function nadalaSilt(nadal) {
  const [a, b] = [nadal.paevad[0], nadal.paevad[4]].map(p => {
    const [, kuu, paev] = p.split('-').map(Number);
    return { paev, kuu: KUUD[kuu - 1] };
  });
  return a.kuu === b.kuu
    ? `${a.paev}.–${b.paev}. ${a.kuu}`
    : `${a.paev}. ${a.kuu} – ${b.paev}. ${b.kuu}`;
}

// Nadalad, mida leht kannab: jooksev ja NADALAID-1 jargmist.
function nadalad(kuupaev) {
  const esm = jooksevEsmaspaev(kuupaev);
  return Array.from({ length: NADALAID }, (_, i) => {
    const algus = lisaPaevi(esm, 7 * i);
    return { paevad: Array.from({ length: 5 }, (_, d) => lisaPaevi(algus, d)) };
  });
}

// ---------------------------------------------------------------
// Asendused
// ---------------------------------------------------------------

// Loeb asendused antud paevade kohta. Iga paev on eraldi POST ja uhe
// paeva ebaonnestumine ei tohi ulejaanuid ara votta, seega puutakse
// viga paeva kaupa: ebaonnestunud paev jaab tuhjaks.
async function laeAsendusedPaeviti(host, paevad) {
  const tulemus = new Map();
  for (let i = 0; i < paevad.length; i += KORRAGA) {
    const osa = paevad.slice(i, i + KORRAGA);
    const vastused = await Promise.all(osa.map(async p => {
      try {
        return [p, await laeAsendused(host, p)];
      } catch (e) {
        console.warn(`  HOIATUS: ${p} asendusi ei saanud (${e.message})`);
        return [p, {}];
      }
    }));
    for (const [p, paeva] of vastused) tulemus.set(p, paeva);
  }
  return tulemus;
}

// Rea jarjekord loetelus: paev, siis esimene tund.
function reaJarjekord(a, b) {
  return (a.paev || '').localeCompare(b.paev || '') ||
    (a.perioodid[0] ?? 99) - (b.perioodid[0] ?? 99);
}

// Muudatuste kast. Rida kannab paeva siis, kui kast katab mitut paeva.
// Pikk loetelu pakitakse kokku: esimesed KOKKU_ALATES rida jaavad
// nahtavale, ulejaanud avanevad "+ veel N" alt.
function asendusteKast(read, pealkiri, alapealkiri, lisaklass = '') {
  const rida = r =>
    `<li>` +
    (r.paev ? `<span class="subst-day">${esc(lyhiKuupaev(r.paev))}</span> ` : '') +
    `<strong>${esc(r.silt)}</strong>` +
    (r.perioodid.length ? ` (${r.perioodid.join('.-')}. tund)` : '') +
    `: ${esc(r.tekst)}</li>`;

  const sorted = [...read].sort(reaJarjekord);
  const nahtavad = sorted.length > KOKKU_ALATES ? sorted.slice(0, KOKKU_ALATES) : sorted;
  const peidetud = sorted.slice(nahtavad.length);

  let html = `<div class="subst-box${lisaklass ? ' ' + lisaklass : ''}"><h3>${esc(pealkiri)} ` +
    `<span class="subst-date">${esc(alapealkiri)}</span></h3>` +
    `<ul>${nahtavad.map(rida).join('')}</ul>`;
  if (peidetud.length) {
    const n = peidetud.length;
    html += `<details class="subst-more"><summary>+ veel ${n} ${n === 1 ? 'muudatus' : 'muudatust'}</summary>` +
      `<ul>${peidetud.map(rida).join('')}</ul></details>`;
  }
  return html + `</div>`;
}

// ---------------------------------------------------------------
// Syndmused
// ---------------------------------------------------------------

// Uks syndmus tuleb korraga mitmes sektsioonis (nt "4.a" ja
// "4.a ind plaan"), seega liidame need teksti jargi kokku.
// Kuulajaskond tuleb "Klass(id)" loendist; kui seda ei ole, siis
// sektsiooni nimest, ja kalendrisektsiooni puhul laheb syndmus koigile.
function syndmusedPaevast(paeva, kuupaev) {
  const kaupa = new Map();

  for (const [sektsioon, read] of Object.entries(paeva)) {
    for (const r of read) {
      if (!r.tyyp.startsWith('event')) continue;

      const olem = kaupa.get(r.tekst) ||
        { kuupaev, tekst: r.tekst, klassid: [], koigile: false };

      if (r.klassid?.length) {
        for (const k of r.klassid) if (!olem.klassid.includes(k)) olem.klassid.push(k);
      } else if (sektsioon === SYNDMUSTE_SEKTSIOON) {
        olem.koigile = true;
      } else if (!olem.klassid.includes(sektsioon)) {
        olem.klassid.push(sektsioon);
      }

      kaupa.set(r.tekst, olem);
    }
  }

  return [...kaupa.values()];
}

function tulemasKast(read) {
  const punktid = read.map(r =>
    `<li><strong>${esc(lyhiKuupaev(r.kuupaev))}</strong>: ${esc(r.tekst)}</li>`
  ).join('');
  return `<div class="subst-box subst-box-event"><h3>Tulemas ` +
    `<span class="subst-date">järgmise ${ETTEVAATE_PAEVI} päeva sees</span></h3>` +
    `<ul>${punktid}</ul></div>`;
}

function tulemasKlassile(tulevased, o) {
  const nimed = [String(o.short || '').trim(), String(o.name || '').trim()].filter(Boolean);
  return tulevased.filter(r => r.koigile || r.klassid.some(k => nimed.includes(k)));
}

// Kooliylene syndmus laheb klassi lehele siis, kui klass on selle
// "Klass(id)" loendis, ja koigile siis, kui loendit ei ole.
// NB! aSc-s on mone klassi nimes lopus tuhik ("1.v "), asenduste lehel
// mitte, seega vordleme trimmitud kujul.
// Sama syndmus voib olla korraga nii kalendris kui klassi enda ridade
// seas, seega viskame duplikaadid valja.
function syndmusedKlassile(syndmused, o, omaread) {
  const nimed = [String(o.short || '').trim(), String(o.name || '').trim()].filter(Boolean);
  return syndmused.filter(r =>
    (!r.klassid?.length || r.klassid.some(k => nimed.includes(k))) &&
    !omaread.some(x => x.tekst === r.tekst)
  );
}

// Klassi read uhel paeval: tema enda sektsioon pluss kooliylesed
// syndmused, mis teda puudutavad. Asendused seotakse klassi nime jargi,
// nagu EduPage neid grupeerib.
function klassiRead(paeva, yld, o) {
  const trimmitud = new Map(Object.entries(paeva).map(([k, v]) => [k.trim(), v]));
  const omaread = trimmitud.get(String(o.short || '').trim()) ||
    trimmitud.get(String(o.name || '').trim()) || [];
  return [...syndmusedKlassile(yld, o, omaread), ...omaread];
}

// ---------------------------------------------------------------
// Sama olem teises tunniplaanis
// ---------------------------------------------------------------

const KOGUD = { class: 'classes', teacher: 'teachers', room: 'classrooms' };

function olemiNimi(tyyp, o) {
  return String(tyyp === 'teacher' ? o.name : (o.short || o.name)).trim();
}

// Id kehtib siis, kui ta on teises plaanis sama nimega; muidu otsime
// nime jargi. aSc hoiab id-d plaanist plaani, aga kindel see ei ole.
function vaste(R, tyyp, o) {
  const kogu = R.DB[KOGUD[tyyp]];
  const sama = kogu[o.id];
  if (sama && olemiNimi(tyyp, sama) === olemiNimi(tyyp, o)) return sama;
  const nimi = olemiNimi(tyyp, o);
  return Object.values(kogu).find(x => olemiNimi(tyyp, x) === nimi) || null;
}

// Lingid teise plaani lehel peavad viima samadele failidele, mis
// esmase plaani jargi tehti. Seega tolgime teise plaani id-d esmase
// plaani slugideks nime kaudu.
function slugidPlaanile(R, Resmane, slugs) {
  const tulemus = {};
  for (const [tyyp, kogu] of Object.entries(KOGUD)) {
    const nimeJargi = new Map(
      Object.values(Resmane.DB[kogu]).map(o => [olemiNimi(tyyp, o), slugs[tyyp][o.id]])
    );
    tulemus[tyyp] = {};
    for (const o of Object.values(R.DB[kogu])) {
      const slug = nimeJargi.get(olemiNimi(tyyp, o));
      if (slug) tulemus[tyyp][o.id] = slug;
    }
  }
  return tulemus;
}

// ---------------------------------------------------------------
// Nadalate vahel liikumine lehel
// ---------------------------------------------------------------

// Nadalad on lehel koik olemas, JS ainult peidab ja naitab. Fookus
// liigub uue nadala pealkirjale: ekraanilugeja kuuleb, kuhu joudis, ja
// nupud on sealt uhe Tabi kaugusel. Enne printimist avatakse
// kokkupakitud loetelud.
const NADALA_SKRIPT = `<script>
(function () {
  var nadalad = Array.prototype.slice.call(document.querySelectorAll('.week'));
  function naita(i) {
    nadalad.forEach(function (n, j) { n.hidden = j !== i; });
    var h = nadalad[i].querySelector('.week-head h3');
    if (h) h.focus();
  }
  nadalad.forEach(function (n, i) {
    var eelmine = n.querySelector('.week-prev');
    var jargmine = n.querySelector('.week-next');
    if (eelmine && !eelmine.disabled) eelmine.addEventListener('click', function () { naita(i - 1); });
    if (jargmine && !jargmine.disabled) jargmine.addEventListener('click', function () { naita(i + 1); });
  });
  window.addEventListener('beforeprint', function () {
    document.querySelectorAll('details.subst-more').forEach(function (d) { d.open = true; });
  });
})();
</script>`;

function nadalaPais(nadal, i, mituPlaani) {
  const vihje = i === 0 ? 'see nädal' : i === 1 ? 'järgmine nädal' : '';
  return `<div class="week-head">` +
    `<button type="button" class="week-btn week-prev print-hide" aria-label="Eelmine nädal"${i === 0 ? ' disabled' : ''}>‹</button>` +
    `<h3 tabindex="-1">${esc(nadalaSilt(nadal))}${vihje ? ` <span class="week-hint">${vihje}</span>` : ''}</h3>` +
    `<button type="button" class="week-btn week-next print-hide" aria-label="Järgmine nädal"${i === NADALAID - 1 ? ' disabled' : ''}>›</button>` +
    (mituPlaani ? `<span class="week-tt">Tunniplaan: ${esc(nadal.tp.text)}</span>` : '') +
    `</div>`;
}

// ---------------------------------------------------------------
// Juurleht
// ---------------------------------------------------------------

// dist/index.html on kogu saidi avaleht: valik oppekohtade vahel.
// Kirjutatakse alles parast oppekohtade genereerimist, sest iga
// oppekoha kaust kustutatakse ja tehakse jooksu alguses uuesti.
function kirjutaJuurLeht(R, seisud) {
  const juur = join(HERE, 'dist');
  mkdirSync(join(juur, 'assets'), { recursive: true });
  writeFileSync(join(juur, 'assets/style.css'), R.getExportCss());

  // Loetleme need oppekohad, mille kaust on olemas. Nii ei teki katkist
  // linki, kui jooksutati ainult uht oppekohta.
  const olemas = Object.entries(KOOLID).filter(
    ([, kool]) => existsSync(join(HERE, kool.valjund, 'index.html'))
  );

  const lingid = olemas.map(([votme, kool]) => {
    const kaust = kool.valjund.replace(/^dist\//, '');
    const silt = esc(kool.nimi.replace(/^Kiviõli Riigikool, /, ''));
    const aegunud = seisud[votme]?.aegunud;
    return `<a href="${kaust}/index.html">${silt}${aegunud ? ' (aegunud)' : ''}</a>`;
  }).join('');

  const hoiatus = olemas.some(([votme]) => seisud[votme]?.aegunud)
    ? `<div class="subst-box"><h3>Tähelepanu</h3><p style="margin:0">` +
      `Vähemalt ühe õppekoha tunniplaan on aegunud: kool ei ole veel uut plaani avaldanud.` +
      `</p></div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="et">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kiviõli Riigikooli tunniplaan</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<div class="container">
<header class="page-header"><h1>Kiviõli Riigikooli tunniplaan</h1></header>
${hoiatus}<div class="nav-group"><h2>Õppekoht</h2><div class="nav-list">${lingid}</div></div>
<p style="color:#666; font-size:0.85rem; margin:1rem 0 0 0">Leht uuendatud ${esc(uuendatud())}.</p>
</div>
</body>
</html>
`;
  writeFileSync(join(juur, 'index.html'), html);
}

// ---------------------------------------------------------------

async function genereeri(votmed, kuupaev) {
  const seisud = {};
  let viimaneR = null;

  for (const votme of votmed) {
    const kool = KOOLID[votme];
    if (!kool) throw new Error(`Tundmatu kool: ${votme}`);

    // Igale nadalale oma plaan. Enamasti on see koigil sama, aga kui
    // kool avaldab uue plaani jargmisest esmaspaevast, peab jooksev
    // nadal naitama veel vana.
    const tunniplaanid = await laeTunniplaanid(kool.host);
    const nadalaList = nadalad(kuupaev);
    for (const n of nadalaList) n.tp = valiTunniplaan(tunniplaanid, n);

    const renderdajad = new Map();
    for (const n of nadalaList) {
      if (!renderdajad.has(n.tp.tt_num)) {
        renderdajad.set(n.tp.tt_num, await laeRenderdajaPlaanile(kool.host, n.tp));
      }
      n.R = renderdajad.get(n.tp.tt_num);
    }
    const mituPlaani = renderdajad.size > 1;

    // Esmane plaan on jooksva nadala oma: sellest tulevad olemid, failid
    // ja lingid.
    const tp = nadalaList[0].tp;
    const R = nadalaList[0].R;
    viimaneR = R;

    // Aegunud tunniplaani avaldamine on hullem kui mitte midagi avaldada.
    const lopp = kehtivuseLopp(R.T);
    const aegunud = Boolean(lopp && lopp < kuupaev);
    if (aegunud) {
      console.warn(
        `\n  !!! AEGUNUD TUNNIPLAAN !!!\n` +
        `  Uusim EduPage'i tunniplaan kehtis kuni ${lopp}, täna on ${kuupaev}.\n` +
        `  Kool ei ole veel uut plaani avaldanud. Neid faile EI TOHI kodulehele panna.\n`
      );
    }
    seisud[votme] = { aegunud, lopp };

    // Asendused tanasest viimase nadala reedeni. Moodunud paevi ei kysi:
    // asendusplaan on tuleviku, mitte ajaloo jaoks, ja iga paev on
    // EduPage'ile eraldi paring.
    const paevad = nadalaList.flatMap(n => n.paevad).filter(p => p >= kuupaev);
    const viimanePaev = paevad[paevad.length - 1];
    const asendusedPaeviti = await laeAsendusedPaeviti(kool.host, paevad);

    // Kooliylesed syndmused tulevad omaette sektsioonis, mille paise ei ole
    // klassi nimi. Ilma eraldi kasitluseta ei leiaks neid ukski klass ja
    // aktus kaoks vaikselt ara.
    const yldPaeviti = new Map();
    for (const [p, paeva] of asendusedPaeviti) {
      yldPaeviti.set(p, paeva[SYNDMUSTE_SEKTSIOON] || []);
      delete paeva[SYNDMUSTE_SEKTSIOON];
    }

    const tanased = yldPaeviti.get(kuupaev) || [];

    // Avalehe ettevaade: syndmused parast tanast, ETTEVAATE_PAEVI ulatuses.
    const ettevaateLopp = lisaPaevi(kuupaev, ETTEVAATE_PAEVI);
    const tulevased = [];
    for (const p of paevad) {
      if (p > kuupaev && p <= ettevaateLopp) {
        const paeva = { ...asendusedPaeviti.get(p), [SYNDMUSTE_SEKTSIOON]: yldPaeviti.get(p) };
        tulevased.push(...syndmusedPaevast(paeva, p));
      }
    }

    const klassid = Object.values(R.DB.classes);
    const opetajad = Object.values(R.DB.teachers);
    const ruumid = Object.values(R.DB.classrooms);

    const slugs = {
      class: R.uniqueSlugs(klassid, c => c.short || c.name),
      teacher: R.uniqueSlugs(opetajad, t => (t.firstname + '-' + t.lastname).trim() || t.name),
      room: R.uniqueSlugs(ruumid, r => r.short || r.name),
    };
    for (const n of nadalaList) {
      n.slugs = n.R === R ? slugs : slugidPlaanile(n.R, R, slugs);
    }

    const juur = join(HERE, kool.valjund);
    rmSync(juur, { recursive: true, force: true });
    for (const d of ['', 'assets', 'klass', 'opetaja', 'ruum']) mkdirSync(join(juur, d), { recursive: true });

    writeFileSync(join(juur, 'assets/style.css'), R.getExportCss());
    // buildIndexPage tagastab terve lehe, seega riba lisame paise jarele.
    const indexHtml = R.buildIndexPage(slugs).replace(
      '<header class="page-header"><h1>Tunniplaan</h1></header>',
      '<header class="page-header"><h1>Tunniplaan</h1></header>' +
        paiseRiba(kool, tp, lopp, kuupaev, viimanePaev, aegunud) +
        // Kooliylene syndmus puudutab kogu maja, seega on ta ka oppekoha
        // avalehel, mitte ainult uksikute klasside lehtedel.
        (tanased.length
          ? asendusteKast(tanased, 'Täna koolis', kuupaev, 'subst-box-event')
          : '') +
        (tulevased.length ? tulemasKast(tulevased) : '')
    );
    writeFileSync(join(juur, 'index.html'), indexHtml);

    // Uks nadal uhe olemi lehel: muudatuste kast ja tabel. Margised
    // tabelis ja kast on ainult klassidel, nagu EduPage asendusi jagab.
    const nadalaOsa = (n, i, tyyp, o) => {
      const olem = vaste(n.R, tyyp, o);
      const read = [];
      const cells = new Map();
      if (tyyp === 'class') {
        n.paevad.forEach((p, d) => {
          if (!asendusedPaeviti.has(p)) return;
          for (const r of klassiRead(asendusedPaeviti.get(p), yldPaeviti.get(p) || [], o)) {
            read.push({ ...r, paev: p });
            for (const per of r.perioodid) cells.set(`${d}:${per}`, r);
          }
        });
      }

      n.R.seaAsendused(cells.size ? cells : null);
      n.R.seaNadal(n.paevad.map(p => ({
        date: lyhiKuupaev(p).slice(2),
        past: p < kuupaev,
        today: p === kuupaev,
      })));
      const tabel = olem
        ? n.R.buildTimetableTable(tyyp, olem.id, n.slugs)
        : '<div class="empty-state">Selle nädala tunniplaanis seda valikut ei ole.</div>';
      n.R.seaAsendused(null);
      n.R.seaNadal(null);

      let kast = '';
      if (read.length) {
        // Punane kast tahendab, et tunniplaan ei kehti nii, nagu ta lehel
        // seisab. Kui klassil on ainult syndmused, ei ole midagi punast
        // teatada, ja kast on sama kollane nagu avalehel.
        const ainultSyndmused = read.every(r => r.tyyp.startsWith('event'));
        kast = ainultSyndmused
          ? asendusteKast(read, 'Sündmused', nadalaSilt(n), 'subst-box-event')
          : asendusteKast(read, 'Muudatused', nadalaSilt(n));
      }

      return {
        muudetud: read.length > 0,
        html: `<section class="week" data-week="${n.paevad[0]}" aria-label="${esc(nadalaSilt(n))}"${i ? ' hidden' : ''}>` +
          nadalaPais(n, i, mituPlaani) + kast + tabel + `</section>`,
      };
    };

    const muudetud = new Set();
    const kirjuta = (kaust, tyyp, olemid, nimi) => {
      for (const o of olemid) {
        const osad = nadalaList.map((n, i) => nadalaOsa(n, i, tyyp, o));
        if (osad.some(x => x.muudetud)) muudetud.add(o.id);

        const omaTulevased = tyyp === 'class' ? tulemasKlassile(tulevased, o) : [];

        const body = R.buildTimetableTitle(tyyp, o.id) +
          (omaTulevased.length ? tulemasKast(omaTulevased) : '') +
          `<noscript><style>.week[hidden]{display:block}</style></noscript>` +
          osad.map(x => x.html).join('') +
          NADALA_SKRIPT;

        const fail = slugs[tyyp][o.id] + '.html';
        writeFileSync(join(juur, kaust, fail), R.wrapInHtmlPage(nimi(o), body, '../assets/style.css'));
      }
    };
    kirjuta('klass', 'class', klassid, c => c.name);
    kirjuta('opetaja', 'teacher', opetajad, t => t.name);
    kirjuta('ruum', 'room', ruumid, r => r.name);

    const plaanid = [...new Set(nadalaList.map(n => `nr ${n.tp.tt_num} alates ${n.tp.datefrom} (${n.tp.text})`))];
    console.log(
      `${kool.nimi}\n` +
      `  tunniplaan ${plaanid.join('; ')}\n` +
      `  ${klassid.length} klassi, ${opetajad.length} õpetajat, ${ruumid.length} ruumi, ` +
      `${R.DB.cards.length} kaarti\n` +
      `  ${NADALAID} nädalat (${nadalaList[0].paevad[0]} kuni ${viimanePaev}), ` +
      `asendused ${paevad.length} päeva kohta, ` +
      `${muudetud.size} klassi muudatustega, ` +
      `${tanased.length} kooliülest sündmust täna, ` +
      `${tulevased.length} tulevast sündmust ${ETTEVAATE_PAEVI} päeva sees\n` +
      `  -> ${kool.valjund}/`
    );
  }

  if (viimaneR) {
    kirjutaJuurLeht(viimaneR, seisud);
    console.log('  -> dist/index.html (õppekoha valik)');
  }
}

const arg = process.argv[2] || 'koik';
const kuupaev = process.argv[3] || new Date().toISOString().slice(0, 10);
const votmed = arg === 'koik' ? Object.keys(KOOLID) : [arg];
genereeri(votmed, kuupaev).catch(err => {
  console.error('VIGA:', err.message);
  // fetchi vead peidavad tegeliku pohjuse cause alla.
  if (err.cause) console.error('  põhjus:', err.cause.code || err.cause.message || err.cause);
  process.exit(1);
});
